import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHandlers: Record<string, Function> = {};
const mockBot = {
  command: vi.fn((cmd: string, handler: Function) => {
    mockHandlers[`command:${cmd}`] = handler;
  }),
  on: vi.fn((event: string, handler: Function) => {
    mockHandlers[`on:${event}`] = handler;
  }),
  catch: vi.fn(),
  launch: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  telegram: { sendMessage: vi.fn() },
  _handlers: mockHandlers,
};

vi.mock("telegraf", () => ({
  Telegraf: vi.fn(function () {
    return mockBot;
  }),
}));

vi.mock("../config.js", () => ({
  config: {
    telegramBotToken: "test-token",
    anthropicApiKey: "test-key",
    redAlertApiKey: "test-key",
    logLevel: "error",
    nodeEnv: "test",
    rateLimitPerUser: 10,
    maxConversationMessages: 20,
    botAdminChatId: null,
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

vi.mock("../rate-limiter.js", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  getRateLimitMessage: vi.fn().mockReturnValue("Rate limited"),
}));

import { createBot } from "../bot.js";
import { Telegraf } from "telegraf";
import { checkRateLimit, getRateLimitMessage } from "../rate-limiter.js";

function createMockCtx(overrides: Record<string, any> = {}) {
  return {
    from: { id: 123 },
    chat: { id: 456 },
    message: { text: "/start" },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithVenue: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function createMockMcpClient() {
  return {
    isConnected: true,
    toolCount: 5,
    tools: [],
    callTool: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
  } as any;
}

function createMockClaudeBridge() {
  return {
    runAgenticLoop: vi.fn().mockResolvedValue({ text: "Bot response", shelters: [] }),
  } as any;
}

function createMockConversationManager() {
  return {
    getOrCreate: vi.fn().mockReturnValue({
      messages: [],
      lastActivity: Date.now(),
      totalTokensUsed: 0,
    }),
    clear: vi.fn(),
    trim: vi.fn(),
    startCleanup: vi.fn(),
    stopCleanup: vi.fn(),
    updateTokenUsage: vi.fn(),
  } as any;
}

describe("bot", () => {
  let mcpClient: ReturnType<typeof createMockMcpClient>;
  let claudeBridge: ReturnType<typeof createMockClaudeBridge>;
  let convManager: ReturnType<typeof createMockConversationManager>;
  let bot: any;
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });

    mcpClient = createMockMcpClient();
    claudeBridge = createMockClaudeBridge();
    convManager = createMockConversationManager();

    bot = createBot(mcpClient, claudeBridge, convManager);
    handlers = mockHandlers;
  });

  describe("/start command", () => {
    it("sends welcome message", async () => {
      const ctx = createMockCtx();
      await handlers["command:start"](ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain("ברוכים הבאים");
      expect(msg).toContain("/help");
    });
  });

  describe("/help command", () => {
    it("sends help message with all commands", async () => {
      const ctx = createMockCtx();
      await handlers["command:help"](ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain("/start");
      expect(msg).toContain("/help");
      expect(msg).toContain("/status");
      expect(msg).toContain("/alerts");
      expect(msg).toContain("/shelters");
      expect(msg).toContain("/clear");
    });
  });

  describe("/status command", () => {
    it("shows connected status when MCP is connected", async () => {
      const ctx = createMockCtx();
      await handlers["command:status"](ctx);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain("Online");
      expect(msg).toContain("Connected");
      expect(msg).toContain("5 tools");
    });

    it("shows disconnected status when MCP is down", async () => {
      mcpClient.isConnected = false;
      const ctx = createMockCtx();
      await handlers["command:status"](ctx);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain("Disconnected");
    });
  });

  describe("/clear command", () => {
    it("clears conversation for user", async () => {
      const ctx = createMockCtx();
      await handlers["command:clear"](ctx);
      expect(convManager.clear).toHaveBeenCalledWith(123);
      expect(ctx.reply).toHaveBeenCalledWith("Conversation history cleared.");
    });

    it("does nothing without ctx.from", async () => {
      const ctx = createMockCtx({ from: undefined });
      await handlers["command:clear"](ctx);
      expect(convManager.clear).not.toHaveBeenCalled();
    });
  });

  describe("/shelters command", () => {
    it("routes to Claude with city name", async () => {
      const ctx = createMockCtx({
        message: { text: "/shelters Tel Aviv" },
      });
      await handlers["command:shelters"](ctx);
      expect(claudeBridge.runAgenticLoop).toHaveBeenCalled();
    });

    it("shows usage when no city given", async () => {
      const ctx = createMockCtx({
        message: { text: "/shelters" },
      });
      await handlers["command:shelters"](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
      );
      expect(claudeBridge.runAgenticLoop).not.toHaveBeenCalled();
    });
  });

  describe("text message handling", () => {
    it("sends typing action and calls Claude bridge", async () => {
      const ctx = createMockCtx({ message: { text: "Show me alerts" } });
      await handlers["on:text"](ctx);

      expect(ctx.sendChatAction).toHaveBeenCalledWith("typing");
      expect(convManager.getOrCreate).toHaveBeenCalledWith(123);
      expect(claudeBridge.runAgenticLoop).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith("Bot response", { parse_mode: "HTML" });
    });

    it("blocks rate-limited users", async () => {
      vi.mocked(checkRateLimit).mockReturnValue({
        allowed: false,
        retryAfterSec: 60,
      });

      const ctx = createMockCtx({ message: { text: "Hi" } });
      await handlers["on:text"](ctx);

      expect(ctx.reply).toHaveBeenCalledWith("Rate limited");
      expect(claudeBridge.runAgenticLoop).not.toHaveBeenCalled();
    });

    it("shows error when MCP is disconnected", async () => {
      mcpClient.isConnected = false;
      const ctx = createMockCtx({ message: { text: "Hi" } });
      await handlers["on:text"](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("restarting"),
      );
      expect(claudeBridge.runAgenticLoop).not.toHaveBeenCalled();
    });

    it("handles bridge errors gracefully", async () => {
      claudeBridge.runAgenticLoop.mockRejectedValueOnce(
        new Error("Claude API error"),
      );

      const ctx = createMockCtx({ message: { text: "Hi" } });
      await handlers["on:text"](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("something went wrong"),
      );
    });

    it("does nothing without ctx.from", async () => {
      const ctx = createMockCtx({ from: undefined, message: { text: "Hi" } });
      await handlers["on:text"](ctx);
      expect(claudeBridge.runAgenticLoop).not.toHaveBeenCalled();
    });
  });

  describe("venue pin sending", () => {
    it("sends a venue pin for the nearest shelter after text response", async () => {
      claudeBridge.runAgenticLoop.mockResolvedValueOnce({
        text: "Found shelters near Tel Aviv.",
        shelters: [
          { lat: 32.08, lon: 34.78, name: "Shelter A", address: "123 Main St", distance: 100 },
          { lat: 32.09, lon: 34.79, name: "Shelter B", address: "456 Other St", distance: 200 },
        ],
      });

      const ctx = createMockCtx({ message: { text: "Find shelters near Tel Aviv" } });
      await handlers["on:text"](ctx);

      expect(ctx.replyWithVenue).toHaveBeenCalledTimes(1);
      expect(ctx.replyWithVenue).toHaveBeenCalledWith(
        32.08,
        34.78,
        "Shelter A",
        "123 Main St",
        { disable_notification: true },
      );
    });

    it("does not send venue pin when no shelters are returned", async () => {
      claudeBridge.runAgenticLoop.mockResolvedValueOnce({
        text: "No shelters found.",
        shelters: [],
      });

      const ctx = createMockCtx({ message: { text: "Show me alerts" } });
      await handlers["on:text"](ctx);

      expect(ctx.replyWithVenue).not.toHaveBeenCalled();
    });

    it("sends only one venue pin even with multiple shelters", async () => {
      claudeBridge.runAgenticLoop.mockResolvedValueOnce({
        text: "Found 3 shelters.",
        shelters: [
          { lat: 32.08, lon: 34.78, name: "Nearest", address: "Addr 1", distance: 50 },
          { lat: 32.09, lon: 34.79, name: "Middle", address: "Addr 2", distance: 150 },
          { lat: 32.10, lon: 34.80, name: "Farthest", address: "Addr 3", distance: 300 },
        ],
      });

      const ctx = createMockCtx({ message: { text: "Find shelters" } });
      await handlers["on:text"](ctx);

      expect(ctx.replyWithVenue).toHaveBeenCalledTimes(1);
      expect(ctx.replyWithVenue).toHaveBeenCalledWith(
        32.08, 34.78, "Nearest", "Addr 1", { disable_notification: true },
      );
    });

    it("uses fallback address when shelter address is empty", async () => {
      claudeBridge.runAgenticLoop.mockResolvedValueOnce({
        text: "Found a shelter.",
        shelters: [
          { lat: 32.08, lon: 34.78, name: "Shelter X", address: "", distance: 100 },
        ],
      });

      const ctx = createMockCtx({ message: { text: "Find shelters" } });
      await handlers["on:text"](ctx);

      expect(ctx.replyWithVenue).toHaveBeenCalledWith(
        32.08, 34.78, "Shelter X", "Shelter", { disable_notification: true },
      );
    });

    it("handles venue send failure gracefully without crashing", async () => {
      claudeBridge.runAgenticLoop.mockResolvedValueOnce({
        text: "Found shelters.",
        shelters: [
          { lat: 32.08, lon: 34.78, name: "Shelter A", address: "123 Main St", distance: 100 },
        ],
      });

      const ctx = createMockCtx({ message: { text: "Find shelters" } });
      ctx.replyWithVenue.mockRejectedValueOnce(new Error("Telegram API error"));

      await handlers["on:text"](ctx);

      // Should not throw - the text reply should still have been sent
      expect(ctx.reply).toHaveBeenCalledWith("Found shelters.", { parse_mode: "HTML" });
      expect(ctx.replyWithVenue).toHaveBeenCalledTimes(1);
    });

    it("sends venue pin after /shelters command", async () => {
      claudeBridge.runAgenticLoop.mockResolvedValueOnce({
        text: "Shelters near Haifa.",
        shelters: [
          { lat: 32.79, lon: 34.99, name: "Haifa Shelter", address: "Harbor Rd", distance: 75 },
        ],
      });

      const ctx = createMockCtx({ message: { text: "/shelters Haifa" } });
      await handlers["command:shelters"](ctx);

      expect(ctx.replyWithVenue).toHaveBeenCalledWith(
        32.79, 34.99, "Haifa Shelter", "Harbor Rd", { disable_notification: true },
      );
    });

    it("sends venue pin after location share", async () => {
      claudeBridge.runAgenticLoop.mockResolvedValueOnce({
        text: "Nearest shelters to your location.",
        shelters: [
          { lat: 31.77, lon: 35.21, name: "Nearby Shelter", address: "Jerusalem Blvd", distance: 30 },
        ],
      });

      const ctx = createMockCtx({
        message: { location: { latitude: 31.77, longitude: 35.21 } },
      });
      await handlers["on:location"](ctx);

      expect(ctx.replyWithVenue).toHaveBeenCalledWith(
        31.77, 35.21, "Nearby Shelter", "Jerusalem Blvd", { disable_notification: true },
      );
    });
  });

  describe("error handler", () => {
    it("registers a catch handler", () => {
      expect(bot.catch).toHaveBeenCalled();
    });
  });
});
