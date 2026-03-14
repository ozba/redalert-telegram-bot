# RedAlert Telegram Bot - Core Architecture

## Overview

A Telegram bot that provides Israel's RedAlert emergency alert data through natural language conversation. The bot spawns the `redalert-mcp-server` as a child process, communicates via MCP protocol over stdio, and uses Claude API (Sonnet) for natural language understanding and tool orchestration.

## Message Flow

```
User (Telegram)
  │
  ▼
Telegraf Bot (long polling)
  │
  ▼
Claude API (Sonnet)
  │  ← sends user message + tool definitions
  │  → returns text or tool_use blocks
  │
  ▼ (if tool_use)
MCP Client
  │  ← calls tool via MCP protocol (stdio)
  │
  ▼
redalert-mcp-server (child process)
  │  ← MCP tool call
  │  → MCP tool result
  │
  ▼
RedAlert API (redalert.orielhaim.com)
```

The agentic loop repeats (Claude → MCP tool call → result → Claude) until Claude returns a final text response, which is sent back to the user on Telegram.

## Project Structure

```
C:/redAlertBot/
├── src/
│   ├── index.ts              # Entry point, orchestrates startup and shutdown
│   ├── config.ts             # Environment variables and validation
│   ├── bot.ts                # Telegraf bot setup, command and message handlers
│   ├── mcp-client.ts         # MCP client: spawn child process, connect, list/call tools
│   ├── claude.ts             # Claude API integration: tool bridging, agentic loop
│   ├── conversation.ts       # Per-user conversation history management
│   └── types.ts              # Shared TypeScript types
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── ARCHITECTURE.md           # This file
├── ARCHITECTURE_BRIDGE.md    # Claude API bridging design
└── ARCHITECTURE_OPS.md       # Deployment and ops design
```

## 1. Telegraf Bot Setup

### Polling vs Webhook

Use **long polling** (`bot.launch()`) for simplicity:
- No SSL certificate or public URL needed
- Works behind NAT/firewalls and in local dev
- Sufficient for the expected load (not a high-traffic bot)
- Webhook can be added later if needed for production scale

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message, explain capabilities |
| `/help` | List available commands and example queries |
| `/status` | Show MCP connection status and bot health |
| `/alerts` | Quick shortcut: get current active alerts |
| `/shelters <city>` | Quick shortcut: find shelters near a city |

### Message Handler

All non-command text messages go through the Claude agentic loop:
1. Receive message from user
2. Load/create conversation history for this user (by `ctx.from.id`)
3. Send to Claude API with tool definitions and conversation history
4. Execute agentic loop (tool calls as needed)
5. Send final text response back to Telegram
6. Save updated conversation history

### Telegram-Specific Concerns

- **Message length**: Telegram has a 4096 character limit. Split long responses into multiple messages.
- **Markdown**: Use Telegram's MarkdownV2 format for rich responses. Fall back to plain text if formatting fails.
- **Typing indicator**: Send `ctx.sendChatAction('typing')` before processing to show the bot is working.
- **Error messages**: Show user-friendly error messages, not raw stack traces.

## 2. MCP Client

### Spawning the MCP Server

```typescript
// Conceptual - spawn redalert-mcp-server as child process
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "redalert-mcp-server"],
  env: {
    ...process.env,
    REDALERT_API_KEY: config.REDALERT_API_KEY,
  },
});

const client = new Client({ name: "redalert-bot", version: "1.0.0" });
await client.connect(transport);
```

### Tool Discovery at Startup

On startup, call `client.listTools()` to get all 12 MCP tools with their schemas. This returns tool names, descriptions, and JSON Schema input definitions. These are cached and converted to Claude API tool format (see ARCHITECTURE_BRIDGE.md).

### Tool Execution

When Claude returns a `tool_use` block, call the corresponding MCP tool:

```typescript
const result = await client.callTool({
  name: toolName,
  arguments: toolArgs,
});
```

The result contains `content` (array of text/image blocks) which is forwarded back to Claude as a `tool_result`.

### MCP Client Lifecycle

The MCP client is a **singleton** - one client instance shared across all users:
- Created once at bot startup
- Tools listed once and cached
- All user requests share the same MCP connection
- On child process crash: detect exit, recreate client, retry pending operations

This works because the MCP server is stateless for REST tools. The real-time subscription tools (subscribe/poll/unsubscribe) maintain state on the server side, but the MCP protocol handles multiplexing.

## 3. MCP Tools Reference

The server exposes 12 tools in two categories:

### REST API Tools (stateless)

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `get_active_alerts` | (none) | Current alerts snapshot |
| `get_stats_summary` | startDate?, endDate?, origin?, include?, topLimit?, timelineGroup? | High-level stats overview |
| `get_stats_cities` | startDate?, endDate?, limit?, offset?, origin?, search?, include? | Per-city alert stats |
| `get_stats_history` | startDate?, endDate?, limit?, offset?, cityId?, cityName?, search?, category?, origin?, sort?, order?, include? | Historical alert records |
| `get_stats_distribution` | startDate?, endDate?, origin?, groupBy?, category?, limit?, offset?, sort?, order? | Alert distribution |
| `search_shelters` | lat?, lon?, city?, limit?, radius?, wheelchairOnly?, shelterType? | Find nearby shelters |
| `get_cities` | search?, zone?, limit?, offset?, include? | City catalog lookup |
| `health_check` | (none) | API health status |

### Real-time Tools (stateful)

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `subscribe_alerts` | alertTypes?, testMode?, timing? | Start receiving live alerts |
| `poll_alerts` | limit?, acknowledge? | Get buffered alerts |
| `unsubscribe_alerts` | (none) | Stop receiving alerts |
| `get_alert_subscription_status` | (none) | Check subscription state |

## 4. Error Handling

### MCP Connection Failures

```
Bot startup:
  1. Spawn MCP server child process
  2. Connect MCP client
  3. List tools → cache
  4. If any step fails → retry up to 3 times with exponential backoff
  5. If still failing → start bot anyway but respond to users with "service unavailable"

During operation:
  1. Child process exit detected → log error → recreate client
  2. Tool call timeout (15s) → return error to Claude, Claude will explain to user
  3. Tool call error → return MCP error to Claude as tool_result with is_error: true
```

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop Telegraf polling (`bot.stop()`)
2. Close MCP client connection (`client.close()`)
3. Kill child process if still running
4. Exit process

## 5. Key Design Decisions

1. **Single MCP client instance**: One child process serves all users. Simpler than per-user processes, and the MCP server handles concurrent requests fine since REST tools are stateless.

2. **Long polling over webhooks**: Simpler deployment, no SSL setup needed. Can switch later.

3. **Claude as the brain**: All user messages go through Claude. No manual command parsing beyond the quick shortcuts. Claude decides which tools to call and how to present results.

4. **TypeScript**: Same language as the MCP server for consistency. Uses ESM modules.

5. **Telegraf v4**: Mature Telegram bot framework for Node.js. Well-typed, middleware-based.

## 6. Dependencies

```json
{
  "dependencies": {
    "telegraf": "^4.16.0",
    "@anthropic-ai/sdk": "^0.39.0",
    "@modelcontextprotocol/sdk": "^1.12.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "vitest": "^3.0.0"
  }
}
```

No additional runtime dependencies needed. The MCP SDK provides the client transport, Telegraf handles Telegram, and the Anthropic SDK handles Claude API calls.
