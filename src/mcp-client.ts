import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { logger } from "./logger.js";

const ALLOWED_TOOLS = new Set([
  "health_check",
  "get_active_alerts",
  "get_cities",
  "search_shelters",
  "get_stats_summary",
  "get_stats_cities",
  "get_stats_history",
  "get_stats_distribution",
]);

export class McpClientManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private baseDelayMs = 1000;
  private connecting = false;
  private cachedTools: Anthropic.Tool[] = [];

  async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;

    try {
      this.transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "redalert-mcp-server"],
        env: {
          ...process.env,
          REDALERT_API_KEY: config.redAlertApiKey,
        } as Record<string, string>,
      });

      this.client = new Client({ name: "redalert-bot", version: "1.0.0" });
      await this.client.connect(this.transport);

      // List tools and cache in Claude API format
      const { tools: mcpTools } = await this.client.listTools();
      this.cachedTools = mcpTools
        .filter((t) => ALLOWED_TOOLS.has(t.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        }));

      this.restartAttempts = 0;
      logger.info({ toolCount: this.cachedTools.length }, "MCP client connected");

      // Listen for transport close to handle crashes
      this.transport.onclose = () => {
        logger.warn("MCP transport closed unexpectedly");
        this.client = null;
        this.transport = null;
        this.handleCrash().catch((err) => {
          logger.error({ err }, "Failed to recover from MCP crash");
        });
      };
    } catch (error) {
      logger.error({ error }, "Failed to connect MCP client");
      this.client = null;
      this.transport = null;
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  private async handleCrash(): Promise<void> {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error("MCP server max restart attempts reached. Giving up.");
      return;
    }

    const delay = this.baseDelayMs * Math.pow(2, this.restartAttempts);
    this.restartAttempts++;
    logger.info({ attempt: this.restartAttempts, delayMs: delay }, "Restarting MCP server");

    await new Promise((r) => setTimeout(r, delay));
    try {
      await this.connect();
    } catch {
      // connect already logs the error; handleCrash will be called again via onclose
    }
  }

  /** Claude API tool definitions (filtered to allowed tools) */
  get tools(): Anthropic.Tool[] {
    return this.cachedTools;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  get toolCount(): number {
    return this.cachedTools.length;
  }

  /** Call an MCP tool by name and return the text content */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    if (!this.client) {
      throw new Error("MCP client not connected");
    }

    const start = Date.now();
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const duration = Date.now() - start;
      logger.info({ tool: name, durationMs: duration }, "MCP tool called");

      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      return { content: text, isError: (result.isError as boolean) ?? false };
    } catch (error) {
      const duration = Date.now() - start;
      logger.warn({ tool: name, durationMs: duration, error }, "MCP tool error");
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore close errors
    }
    this.client = null;
    this.transport = null;
    logger.info("MCP client closed");
  }
}
