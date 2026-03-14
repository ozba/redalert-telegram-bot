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
    runAgenticLoop: vi.fn().mockResolvedValue("Bot response"),
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
      expect(msg).toContain("Welcome");
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
      expect(ctx.reply).toHaveBeenCalledWith("Bot response");
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

  describe("error handler", () => {
    it("registers a catch handler", () => {
      expect(bot.catch).toHaveBeenCalled();
    });
  });
});
