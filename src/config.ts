function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  redAlertApiKey: requireEnv("REDALERT_API_KEY"),
  nodeEnv: process.env.NODE_ENV || "production",
  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  rateLimitPerUser: parseInt(process.env.RATE_LIMIT_PER_USER || "10", 10),
  maxConversationMessages: parseInt(process.env.MAX_CONVERSATION_MESSAGES || "20", 10),
  botAdminChatId: process.env.BOT_ADMIN_CHAT_ID || null,
};
