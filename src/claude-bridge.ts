import Anthropic from "@anthropic-ai/sdk";
import type { McpClientManager } from "./mcp-client.js";
import { getSystemPrompt } from "./system-prompt.js";
import type { UserConversation, ConversationManager } from "./conversation.js";
import { logger } from "./logger.js";

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 2048;
const MAX_ITERATIONS = 10;
const MAX_TOOL_RESULT_BYTES = 50_000;

function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_BYTES) return text;
  return (
    text.slice(0, MAX_TOOL_RESULT_BYTES) +
    "\n\n[Result truncated — too large to display in full]"
  );
}


export class ClaudeBridge {
  private anthropic: Anthropic;
  private mcpClient: McpClientManager;
  private conversationManager: ConversationManager;

  constructor(
    mcpClient: McpClientManager,
    conversationManager: ConversationManager,
  ) {
    this.anthropic = new Anthropic();
    this.mcpClient = mcpClient;
    this.conversationManager = conversationManager;
  }

  /**
   * Run the Claude agentic loop for a conversation.
   * Sends messages to Claude with available tools, executes tool calls via MCP,
   * and loops until Claude returns a final text response.
   */
  async runAgenticLoop(conv: UserConversation): Promise<string> {
    const tools = this.mcpClient.tools;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let response: Anthropic.Message;
      try {
        response = await this.anthropic.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: getSystemPrompt(),
          messages: conv.messages,
          tools,
        });
      } catch (error: unknown) {
        // If conversation history is corrupted (orphaned tool_result), reset and retry
        if (error instanceof Anthropic.BadRequestError &&
            String(error.message).includes("tool_result")) {
          logger.warn("Corrupted conversation history detected, resetting");
          const lastUserMsg = conv.messages.filter(m => m.role === "user" && typeof m.content === "string").pop();
          conv.messages = lastUserMsg ? [lastUserMsg] : [];
          conv.totalTokensUsed = 0;
          if (conv.messages.length > 0) continue; // retry with clean history
        }
        throw error;
      }

      this.conversationManager.updateTokenUsage(conv, response.usage);
      logger.debug(
        { iteration: i, stopReason: response.stop_reason, usage: response.usage },
        "Claude API response",
      );

      const textParts: string[] = [];
      const toolUses: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "text") textParts.push(block.text);
        if (block.type === "tool_use") toolUses.push(block);
      }

      // If no tool calls or stop reason is end_turn, we're done
      if (toolUses.length === 0 || response.stop_reason === "end_turn") {
        conv.messages.push({ role: "assistant", content: response.content });
        return (
          textParts.join("\n") ||
          "I couldn't generate a response. Please try again."
        );
      }

      // Append assistant response (with tool_use blocks) to history
      conv.messages.push({ role: "assistant", content: response.content });

      // Execute all tool calls concurrently via MCP
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (toolUse) => {
          try {
            const result = await this.mcpClient.callTool(
              toolUse.name,
              toolUse.input as Record<string, unknown>,
            );

            return {
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: truncateToolResult(result.content),
              is_error: result.isError,
            };
          } catch (error) {
            return {
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
              is_error: true,
            };
          }
        }),
      );

      // Append tool results as a user message
      conv.messages.push({ role: "user", content: toolResults });
    }

    return "I was unable to complete the request within the allowed number of steps. Please try a simpler question.";
  }
}
