import { describe, it, expect, vi, beforeEach } from "vitest";

let mockClient: any;
let mockTransport: any;

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function (this: any) {
    Object.assign(this, mockClient);
    return this;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function (this: any) {
    Object.assign(this, mockTransport);
    return this;
  }),
}));

vi.mock("../config.js", () => ({
  config: {
    redAlertApiKey: "test-api-key",
    logLevel: "error",
    nodeEnv: "test",
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { McpClientManager } from "../mcp-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function createMockClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: "get_active_alerts",
          description: "Get active alerts",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "search_shelters",
          description: "Search shelters",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
        {
          name: "some_internal_tool",
          description: "Internal tool not in allow list",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }),
    callTool: vi.fn(),
  };
}

describe("McpClientManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    mockTransport = { onclose: null };
  });

  describe("connect", () => {
    it("creates transport and client, lists tools", async () => {
      const manager = new McpClientManager();
      await manager.connect();

      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "npx",
          args: ["-y", "redalert-mcp-server"],
        }),
      );
      expect(Client).toHaveBeenCalledWith({ name: "redalert-bot", version: "1.0.0" });
      expect(mockClient.connect).toHaveBeenCalled();
      expect(mockClient.listTools).toHaveBeenCalled();
      expect(manager.isConnected).toBe(true);
    });

    it("filters tools to allowed list", async () => {
      const manager = new McpClientManager();
      await manager.connect();

      expect(manager.toolCount).toBe(2);
      expect(manager.tools.map((t) => t.name)).toEqual([
        "get_active_alerts",
        "search_shelters",
      ]);
    });

    it("converts MCP tools to Claude API format", async () => {
      const manager = new McpClientManager();
      await manager.connect();

      const tools = manager.tools;
      expect(tools[0]).toEqual({
        name: "get_active_alerts",
        description: "Get active alerts",
        input_schema: { type: "object", properties: {} },
      });
    });

    it("handles connection failure", async () => {
      mockClient.connect.mockRejectedValueOnce(new Error("spawn failed"));
      const manager = new McpClientManager();

      await expect(manager.connect()).rejects.toThrow("spawn failed");
      expect(manager.isConnected).toBe(false);
    });

    it("skips if already connecting", async () => {
      const manager = new McpClientManager();
      const p1 = manager.connect();
      const p2 = manager.connect();
      await Promise.all([p1, p2]);

      // Client constructor should be called only once
      expect(Client).toHaveBeenCalledTimes(1);
    });
  });

  describe("callTool", () => {
    it("calls MCP tool and returns text content", async () => {
      mockClient.callTool.mockResolvedValueOnce({
        content: [{ type: "text", text: "Alert data here" }],
        isError: false,
      });

      const manager = new McpClientManager();
      await manager.connect();

      const result = await manager.callTool("get_active_alerts", {});
      expect(result).toEqual({ content: "Alert data here", isError: false });
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: "get_active_alerts",
        arguments: {},
      });
    });

    it("concatenates multiple text blocks", async () => {
      mockClient.callTool.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
        isError: false,
      });

      const manager = new McpClientManager();
      await manager.connect();

      const result = await manager.callTool("test", {});
      expect(result.content).toBe("Part 1\nPart 2");
    });

    it("throws when not connected", async () => {
      const manager = new McpClientManager();
      await expect(manager.callTool("test", {})).rejects.toThrow(
        "MCP client not connected",
      );
    });

    it("propagates tool errors", async () => {
      mockClient.callTool.mockRejectedValueOnce(new Error("tool failed"));

      const manager = new McpClientManager();
      await manager.connect();

      await expect(manager.callTool("bad_tool", {})).rejects.toThrow("tool failed");
    });

    it("returns isError flag from MCP", async () => {
      mockClient.callTool.mockResolvedValueOnce({
        content: [{ type: "text", text: "error details" }],
        isError: true,
      });

      const manager = new McpClientManager();
      await manager.connect();

      const result = await manager.callTool("test", {});
      expect(result.isError).toBe(true);
    });
  });

  describe("close", () => {
    it("closes the client and marks as disconnected", async () => {
      const manager = new McpClientManager();
      await manager.connect();
      await manager.close();

      expect(mockClient.close).toHaveBeenCalled();
      expect(manager.isConnected).toBe(false);
    });

    it("handles close errors gracefully", async () => {
      mockClient.close.mockRejectedValueOnce(new Error("close error"));

      const manager = new McpClientManager();
      await manager.connect();

      await expect(manager.close()).resolves.toBeUndefined();
      expect(manager.isConnected).toBe(false);
    });

    it("handles close when not connected", async () => {
      const manager = new McpClientManager();
      await expect(manager.close()).resolves.toBeUndefined();
    });
  });
});
