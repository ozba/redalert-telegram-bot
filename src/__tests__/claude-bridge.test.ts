import { describe, it, expect, vi, beforeEach } from "vitest";

let mockMessagesCreate: ReturnType<typeof vi.fn>;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn(function (this: any) {
      this.messages = { create: mockMessagesCreate };
      return this;
    }),
  };
});

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    anthropicApiKey: "test-key",
    logLevel: "error",
    nodeEnv: "test",
  },
}));

import { ClaudeBridge } from "../claude-bridge.js";
import { ConversationManager } from "../conversation.js";

function createMockMcpClient(tools: any[] = []) {
  return {
    tools,
    isConnected: true,
    toolCount: tools.length,
    callTool: vi.fn(),
  } as any;
}

describe("ClaudeBridge", () => {
  let conversationManager: ConversationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessagesCreate = vi.fn();
    conversationManager = new ConversationManager();
  });

  function getBridge(tools: any[] = []) {
    const mcpClient = createMockMcpClient(tools);
    const bridge = new ClaudeBridge(mcpClient, conversationManager);
    return { bridge, mcpClient };
  }

  describe("runAgenticLoop", () => {
    it("returns text response when Claude gives end_turn", async () => {
      const { bridge } = getBridge();
      const conv = conversationManager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "Hello" });

      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hi there!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const result = await bridge.runAgenticLoop(conv);
      expect(result).toBe("Hi there!");
    });

    it("returns fallback when Claude gives empty text", async () => {
      const { bridge } = getBridge();
      const conv = conversationManager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "Hello" });

      mockMessagesCreate.mockResolvedValueOnce({
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const result = await bridge.runAgenticLoop(conv);
      expect(result).toContain("couldn't generate");
    });

    it("executes tool calls and loops", async () => {
      const tools = [
        { name: "get_active_alerts", description: "Get alerts", input_schema: { type: "object" } },
      ];
      const { bridge, mcpClient } = getBridge(tools);
      const conv = conversationManager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "Show me alerts" });

      // First call: Claude returns a tool_use
      mockMessagesCreate.mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "get_active_alerts",
            input: {},
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      // Mock MCP tool call
      mcpClient.callTool.mockResolvedValueOnce({
        content: "No active alerts",
        isError: false,
      });

      // Second call: Claude returns final text
      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "There are no active alerts right now." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 80, output_tokens: 20 },
      });

      const result = await bridge.runAgenticLoop(conv);
      expect(result).toBe("There are no active alerts right now.");
      expect(mcpClient.callTool).toHaveBeenCalledWith("get_active_alerts", {});
      expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    });

    it("handles tool call errors gracefully", async () => {
      const tools = [
        { name: "get_active_alerts", description: "Get alerts", input_schema: { type: "object" } },
      ];
      const { bridge, mcpClient } = getBridge(tools);
      const conv = conversationManager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "Show me alerts" });

      // Claude requests a tool
      mockMessagesCreate.mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "get_active_alerts",
            input: {},
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      // Tool call fails
      mcpClient.callTool.mockRejectedValueOnce(new Error("MCP connection lost"));

      // Claude responds with error context
      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Sorry, I couldn't fetch the alerts." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 80, output_tokens: 15 },
      });

      const result = await bridge.runAgenticLoop(conv);
      expect(result).toBe("Sorry, I couldn't fetch the alerts.");

      // Verify the tool error was sent back to Claude
      const lastUserMsg = conv.messages.find(
        (m, i) => m.role === "user" && i > 0 && Array.isArray(m.content),
      );
      expect(lastUserMsg).toBeDefined();
      const toolResult = (lastUserMsg!.content as any[])[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content).toContain("MCP connection lost");
    });

    it("stops after max iterations", async () => {
      const tools = [
        { name: "get_active_alerts", description: "Get alerts", input_schema: { type: "object" } },
      ];
      const { bridge, mcpClient } = getBridge(tools);
      const conv = conversationManager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "Loop forever" });

      // Claude always returns tool_use (never end_turn)
      mcpClient.callTool.mockResolvedValue({
        content: "data",
        isError: false,
      });

      for (let i = 0; i < 10; i++) {
        mockMessagesCreate.mockResolvedValueOnce({
          content: [
            {
              type: "tool_use",
              id: `tool_${i}`,
              name: "get_active_alerts",
              input: {},
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 10 },
        });
      }

      const result = await bridge.runAgenticLoop(conv);
      expect(result).toContain("unable to complete");
      expect(mockMessagesCreate).toHaveBeenCalledTimes(10);
    });

    it("updates token usage on each iteration", async () => {
      const { bridge } = getBridge();
      const conv = conversationManager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "Hi" });

      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      await bridge.runAgenticLoop(conv);
      expect(conv.totalTokensUsed).toBe(150);
    });

    it("handles multiple concurrent tool calls", async () => {
      const tools = [
        { name: "get_active_alerts", description: "Get alerts", input_schema: { type: "object" } },
        { name: "search_shelters", description: "Search shelters", input_schema: { type: "object" } },
      ];
      const { bridge, mcpClient } = getBridge(tools);
      const conv = conversationManager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "Alerts and shelters" });

      // Claude returns two tool calls
      mockMessagesCreate.mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "t1", name: "get_active_alerts", input: {} },
          { type: "tool_use", id: "t2", name: "search_shelters", input: { city: "Tel Aviv" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 40 },
      });

      mcpClient.callTool
        .mockResolvedValueOnce({ content: "Alert data", isError: false })
        .mockResolvedValueOnce({ content: "Shelter data", isError: false });

      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Here are the alerts and shelters." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 30 },
      });

      const result = await bridge.runAgenticLoop(conv);
      expect(result).toBe("Here are the alerts and shelters.");
      expect(mcpClient.callTool).toHaveBeenCalledTimes(2);
    });
  });
});
