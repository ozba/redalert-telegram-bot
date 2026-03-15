import type Anthropic from "@anthropic-ai/sdk";

const MAX_MESSAGES = 40;
const AGGRESSIVE_TRIM_TOKEN_THRESHOLD = 100_000;
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface UserConversation {
  messages: Anthropic.MessageParam[];
  lastActivity: number;
  totalTokensUsed: number;
}

export class ConversationManager {
  private conversations = new Map<number, UserConversation>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  getOrCreate(userId: number): UserConversation {
    let conv = this.conversations.get(userId);
    if (!conv) {
      conv = {
        messages: [],
        lastActivity: Date.now(),
        totalTokensUsed: 0,
      };
      this.conversations.set(userId, conv);
    }
    return conv;
  }

  clear(userId: number): void {
    this.conversations.delete(userId);
  }

  trim(conv: UserConversation): void {
    if (conv.totalTokensUsed > AGGRESSIVE_TRIM_TOKEN_THRESHOLD) {
      conv.messages = conv.messages.slice(-10);
      conv.totalTokensUsed = 0;
    }

    while (conv.messages.length > MAX_MESSAGES) {
      conv.messages.shift();
    }

    // Ensure conversation doesn't start with a tool_result (orphaned from trim)
    // or an assistant message. Must start with a user text message.
    while (conv.messages.length > 0) {
      const first = conv.messages[0];
      if (first.role === "user" && typeof first.content === "string") break;
      conv.messages.shift();
    }
  }

  updateTokenUsage(
    conv: UserConversation,
    usage: { input_tokens: number; output_tokens: number },
  ): void {
    conv.totalTokensUsed += usage.input_tokens + usage.output_tokens;
    conv.lastActivity = Date.now();
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [userId, conv] of this.conversations) {
        if (now - conv.lastActivity > CONVERSATION_TTL_MS) {
          this.conversations.delete(userId);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
