import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ConversationManager } from "../conversation.js";
import type { UserConversation } from "../conversation.js";

describe("ConversationManager", () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager();
  });

  afterEach(() => {
    manager.stopCleanup();
  });

  describe("getOrCreate", () => {
    it("creates a new conversation for unknown user", () => {
      const conv = manager.getOrCreate(1);
      expect(conv.messages).toEqual([]);
      expect(conv.totalTokensUsed).toBe(0);
      expect(conv.lastActivity).toBeGreaterThan(0);
    });

    it("returns the same conversation for the same user", () => {
      const conv1 = manager.getOrCreate(1);
      conv1.messages.push({ role: "user", content: "hello" });
      const conv2 = manager.getOrCreate(1);
      expect(conv2.messages).toHaveLength(1);
      expect(conv2).toBe(conv1);
    });

    it("returns different conversations for different users", () => {
      const conv1 = manager.getOrCreate(1);
      const conv2 = manager.getOrCreate(2);
      expect(conv1).not.toBe(conv2);
    });
  });

  describe("clear", () => {
    it("removes the conversation for a user", () => {
      const conv = manager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "hi" });
      manager.clear(1);
      const newConv = manager.getOrCreate(1);
      expect(newConv.messages).toEqual([]);
    });

    it("does nothing for unknown user", () => {
      expect(() => manager.clear(999)).not.toThrow();
    });
  });

  describe("trim", () => {
    it("trims messages to 40 when exceeded", () => {
      const conv = manager.getOrCreate(1);
      for (let i = 0; i < 50; i++) {
        conv.messages.push({ role: "user", content: `msg ${i}` });
      }
      manager.trim(conv);
      expect(conv.messages).toHaveLength(40);
      // Should keep the last 40
      expect((conv.messages[0] as { content: string }).content).toBe("msg 10");
    });

    it("aggressively trims when token threshold exceeded", () => {
      const conv = manager.getOrCreate(1);
      conv.totalTokensUsed = 100_001;
      for (let i = 0; i < 30; i++) {
        conv.messages.push({ role: "user", content: `msg ${i}` });
      }
      manager.trim(conv);
      expect(conv.messages).toHaveLength(10);
      expect(conv.totalTokensUsed).toBe(0);
    });

    it("does not trim when under limits", () => {
      const conv = manager.getOrCreate(1);
      for (let i = 0; i < 10; i++) {
        conv.messages.push({ role: "user", content: `msg ${i}` });
      }
      manager.trim(conv);
      expect(conv.messages).toHaveLength(10);
    });
  });

  describe("updateTokenUsage", () => {
    it("accumulates token usage", () => {
      const conv = manager.getOrCreate(1);
      manager.updateTokenUsage(conv, { input_tokens: 100, output_tokens: 50 });
      expect(conv.totalTokensUsed).toBe(150);
      manager.updateTokenUsage(conv, { input_tokens: 200, output_tokens: 100 });
      expect(conv.totalTokensUsed).toBe(450);
    });

    it("updates lastActivity", () => {
      const conv = manager.getOrCreate(1);
      const before = conv.lastActivity;
      // Small delay to ensure different timestamp
      vi.spyOn(Date, "now").mockReturnValue(before + 1000);
      manager.updateTokenUsage(conv, { input_tokens: 1, output_tokens: 1 });
      expect(conv.lastActivity).toBe(before + 1000);
      vi.restoreAllMocks();
    });
  });

  describe("cleanup", () => {
    it("removes stale conversations", () => {
      vi.useFakeTimers();
      const conv = manager.getOrCreate(1);
      conv.lastActivity = Date.now() - 31 * 60 * 1000; // 31 minutes ago

      manager.startCleanup();
      // Advance past cleanup interval
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Should be cleaned up - getOrCreate returns fresh one
      const newConv = manager.getOrCreate(1);
      expect(newConv.messages).toEqual([]);

      manager.stopCleanup();
      vi.useRealTimers();
    });

    it("keeps active conversations", () => {
      vi.useFakeTimers();
      const conv = manager.getOrCreate(1);
      conv.messages.push({ role: "user", content: "hello" });
      conv.lastActivity = Date.now(); // recent

      manager.startCleanup();
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      const sameConv = manager.getOrCreate(1);
      expect(sameConv.messages).toHaveLength(1);

      manager.stopCleanup();
      vi.useRealTimers();
    });

    it("startCleanup is idempotent", () => {
      manager.startCleanup();
      manager.startCleanup(); // should not throw or create duplicate timers
      manager.stopCleanup();
    });
  });
});
