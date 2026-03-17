import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { McpClientManager } from "./mcp-client.js";
import type { ClaudeBridge } from "./claude-bridge.js";
import type { ConversationManager } from "./conversation.js";
import { checkRateLimit, getRateLimitMessage } from "./rate-limiter.js";
import { UserTracker } from "./user-tracker.js";

const startTime = Date.now();
const userTracker = new UserTracker();

function formatUptime(): string {
  const ms = Date.now() - startTime;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  const MAX_LENGTH = 4096;
  if (text.length <= MAX_LENGTH) {
    await ctx.reply(text);
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      await ctx.reply(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitAt <= 0) splitAt = MAX_LENGTH;

    await ctx.reply(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
}

export function createBot(
  mcpClient: McpClientManager,
  claudeBridge: ClaudeBridge,
  conversationManager: ConversationManager,
): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      `ברוכים הבאים לבוט צבע אדום! 🚨\n\n` +
        `אני יכול לעזור לך עם מערכת ההתרעות של פיקוד העורף:\n\n` +
        `- בדיקת התראות פעילות כרגע\n` +
        `- חיפוש מקלטים קרובים לפי עיר או שיתוף מיקום 📍\n` +
        `- סטטיסטיקות והיסטוריית התראות\n` +
        `- חיפוש מידע על ערים\n\n` +
        `פשוט שלח לי הודעה בעברית או באנגלית!\n\n` +
        `הקלד /help לפרטים נוספים.`,
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `פקודות הבוט:\n\n` +
        `/start - הודעת פתיחה\n` +
        `/help - הודעת עזרה\n` +
        `/status - סטטוס הבוט והשרת\n` +
        `/alerts - בדיקת התראות פעילות\n` +
        `/shelters <עיר> - חיפוש מקלטים ליד עיר\n` +
        `/clear - איפוס היסטוריית שיחה\n\n` +
        `או פשוט שאל אותי בשפה חופשית:\n` +
        `- "תראה לי התראות פעילות"\n` +
        `- "חפש מקלטים ליד תל אביב"\n` +
        `- "כמה התראות היו השבוע?"\n\n` +
        `אפשר גם לשתף מיקום כדי למצוא את המקלטים הקרובים אליך!`,
    );
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(
      `RedAlert Bot Status\n---\n` +
        `Bot: Online\n` +
        `MCP Server: ${mcpClient.isConnected ? `Connected (${mcpClient.toolCount} tools available)` : "Disconnected"}\n` +
        `Uptime: ${formatUptime()}`,
    );
  });

  bot.command("stats", async (ctx) => {
    const username = ctx.from?.username ?? "";
    const adminUsername = process.env.BOT_ADMIN_USERNAME ?? "";
    if (!adminUsername || username !== adminUsername) {
      await ctx.reply("❌");
      return;
    }
    await ctx.reply(
      `📊 Bot Stats\n---\n` +
      `Users: ${userTracker.uniqueUserCount}\n` +
      `Total messages: ${userTracker.totalMessageCount}\n` +
      `Uptime: ${formatUptime()}`
    );
  });

  bot.command("clear", async (ctx) => {
    if (!ctx.from) return;
    conversationManager.clear(ctx.from.id);
    await ctx.reply("Conversation history cleared.");
  });

  bot.command("alerts", async (ctx) => {
    if (!ctx.from) return;
    await handleTextMessage(
      ctx,
      "Show me the current active alerts right now",
      mcpClient,
      claudeBridge,
      conversationManager,
    );
  });

  bot.command("shelters", async (ctx) => {
    if (!ctx.from) return;
    const city = ctx.message.text.replace(/^\/shelters\s*/, "").trim();
    if (!city) {
      await ctx.reply("Usage: /shelters <city name>\nExample: /shelters Tel Aviv");
      return;
    }
    await handleTextMessage(
      ctx,
      `Find shelters near ${city}`,
      mcpClient,
      claudeBridge,
      conversationManager,
    );
  });

  bot.on("location", async (ctx) => {
    if (!ctx.from) return;
    const { latitude, longitude } = ctx.message.location;
    await handleTextMessage(
      ctx,
      `מצא את 5 המקלטים הקרובים ביותר למיקום שלי: lat=${latitude}, lon=${longitude}. הצג מרחק וכתובת.`,
      mcpClient,
      claudeBridge,
      conversationManager,
      true, // skip rate limit for location messages
    );
  });

  bot.on("text", async (ctx) => {
    if (!ctx.from) return;
    await handleTextMessage(ctx, ctx.message.text, mcpClient, claudeBridge, conversationManager);
  });

  bot.catch((err, ctx) => {
    logger.error({ err, chatId: ctx.chat?.id }, "Unhandled bot error");
  });

  return bot;
}

async function handleTextMessage(
  ctx: Context,
  text: string,
  mcpClient: McpClientManager,
  claudeBridge: ClaudeBridge,
  conversationManager: ConversationManager,
  skipRateLimit = false,
): Promise<void> {
  const userId = ctx.from!.id;
  userTracker.track(userId);

  // Rate limit check (skipped for location messages)
  const rateCheck = skipRateLimit ? { allowed: true } : checkRateLimit(userId);
  if (!rateCheck.allowed) {
    await ctx.reply(getRateLimitMessage(rateCheck.retryAfterSec));
    return;
  }

  // Check MCP connection
  if (!mcpClient.isConnected) {
    await ctx.reply(
      "The alert service is temporarily restarting. Please try again in a few seconds.",
    );
    return;
  }

  logger.info({ userId, chatId: ctx.chat?.id }, "Handling user message");

  // Send typing indicator
  await ctx.sendChatAction("typing");
  const typingInterval = setInterval(async () => {
    try {
      await ctx.sendChatAction("typing");
    } catch {
      // ignore
    }
  }, 5000);

  try {
    const conv = conversationManager.getOrCreate(userId);
    conv.messages.push({ role: "user", content: text });

    const response = await claudeBridge.runAgenticLoop(conv);

    await sendLongMessage(ctx, response);

    conv.lastActivity = Date.now();
    conversationManager.trim(conv);
  } catch (err: unknown) {
    logger.error({ err, userId }, "Error handling message");
    await ctx.reply("Sorry, something went wrong. Please try again.");
  } finally {
    clearInterval(typingInterval);
  }
}
