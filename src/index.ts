import { config } from "./config.js";
import { logger } from "./logger.js";
import { McpClientManager } from "./mcp-client.js";
import { ClaudeBridge } from "./claude-bridge.js";
import { ConversationManager } from "./conversation.js";
import { createBot } from "./bot.js";

async function main(): Promise<void> {
  logger.info("Starting RedAlert Telegram Bot...");

  // 1. Spawn MCP server and connect
  const mcpClient = new McpClientManager();

  let retries = 3;
  while (retries > 0) {
    try {
      await mcpClient.connect();
      break;
    } catch (error) {
      retries--;
      if (retries === 0) {
        logger.error({ error }, "Failed to connect MCP client after 3 attempts");
        throw error;
      }
      logger.warn({ error, retriesLeft: retries }, "MCP connection failed, retrying...");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 2. Initialize conversation manager and Claude bridge
  const conversationManager = new ConversationManager();
  conversationManager.startCleanup();

  const claudeBridge = new ClaudeBridge(mcpClient, conversationManager);
  logger.info({ toolCount: mcpClient.toolCount }, "Claude bridge initialized");

  // 3. Create and start Telegraf bot
  const bot = createBot(mcpClient, claudeBridge, conversationManager);

  // 4. Graceful shutdown
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutdown initiated");

    bot.stop(signal);
    conversationManager.stopCleanup();
    await mcpClient.close();

    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // 5. Start polling
  await bot.launch();
  logger.info("Bot is running");

  // 6. Notify admin if configured
  if (config.botAdminChatId) {
    try {
      await bot.telegram.sendMessage(
        config.botAdminChatId,
        "RedAlert Bot started successfully.",
      );
    } catch (error) {
      logger.warn({ error }, "Failed to notify admin");
    }
  }
}

main().catch((error) => {
  logger.error({ error }, "Fatal error");
  process.exit(1);
});
