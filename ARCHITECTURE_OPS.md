# RedAlert Telegram Bot - Deployment, Configuration & Ops Architecture

## 1. Environment Variables

All configuration is via environment variables. No config files.

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather | `7123456789:AAH...` |
| `ANTHROPIC_API_KEY` | Yes | Claude API key for LLM calls | `sk-ant-api03-...` |
| `REDALERT_API_KEY` | Yes | RedAlert API key (passed to MCP server child process) | `ra_...` |
| `NODE_ENV` | No | `production` or `development` (default: `production`) | `production` |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) | `info` |
| `RATE_LIMIT_PER_USER` | No | Max messages per user per minute (default: `10`) | `10` |
| `MAX_CONVERSATION_MESSAGES` | No | Sliding window size per user (default: `20`) | `20` |
| `BOT_ADMIN_CHAT_ID` | No | Telegram chat ID for admin notifications | `123456789` |

### Validation

At startup, `src/config.ts` validates all required variables are set and non-empty. If any are missing, the process logs the missing variable names (not values) and exits with code 1.

```typescript
// src/config.ts
export const config = {
  telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
  redAlertApiKey: requireEnv('REDALERT_API_KEY'),
  nodeEnv: process.env.NODE_ENV || 'production',
  logLevel: process.env.LOG_LEVEL || 'info',
  rateLimitPerUser: parseInt(process.env.RATE_LIMIT_PER_USER || '10', 10),
  maxConversationMessages: parseInt(process.env.MAX_CONVERSATION_MESSAGES || '20', 10),
  botAdminChatId: process.env.BOT_ADMIN_CHAT_ID || null,
};
```

### `.env.example`

Shipped in the repo for local dev reference. Never commit `.env` itself.

```
TELEGRAM_BOT_TOKEN=
ANTHROPIC_API_KEY=
REDALERT_API_KEY=
NODE_ENV=development
LOG_LEVEL=debug
```

## 2. Dockerfile

Multi-stage build. Final image is minimal.

```dockerfile
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# npx is used to spawn redalert-mcp-server child process
# Pre-install it so first spawn is fast
RUN npx -y redalert-mcp-server --help || true

ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
```

Key decisions:
- `node:22-slim` - small image, LTS Node.js
- Multi-stage: dev dependencies only in build stage
- Pre-install MCP server package in image so `npx -y redalert-mcp-server` doesn't download at runtime
- Run as non-root `node` user

## 3. Docker Compose (Local Dev)

```yaml
# docker-compose.yml
services:
  bot:
    build: .
    env_file: .env
    restart: unless-stopped
    volumes:
      - ./src:/app/src:ro  # for dev hot-reload (only in dev)
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(0)"]
      interval: 30s
      timeout: 5s
      retries: 3
```

For development without Docker, just use `npm run dev` with `.env` loaded via `--env-file` flag (Node 22 supports this natively).

## 4. package.json Scripts

```json
{
  "scripts": {
    "start": "node dist/index.js",
    "dev": "tsx watch --env-file=.env src/index.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "docker:build": "docker build -t redalert-bot .",
    "docker:run": "docker run --env-file .env redalert-bot"
  }
}
```

- `npm start` - production entry point
- `npm run dev` - development with watch mode and `.env` auto-loaded
- `npm run build` - compile TypeScript
- `npm run docker:build` / `docker:run` - Docker shortcuts

## 5. Graceful Shutdown

The bot manages two resources: the Telegraf bot and the MCP child process. Shutdown must be orderly.

```
SIGTERM/SIGINT received
  1. Stop Telegraf (stop accepting new updates)
  2. Wait for in-flight message handlers to complete (5s timeout)
  3. Kill MCP child process (SIGTERM, then SIGKILL after 3s)
  4. Exit process with code 0
```

Implementation in `src/index.ts`:

```typescript
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown initiated');

  // 1. Stop accepting Telegram updates
  bot.stop(signal);

  // 2. Disconnect MCP client gracefully
  await mcpClient.close();

  // 3. Kill MCP child process if still alive
  if (mcpProcess && !mcpProcess.killed) {
    mcpProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        mcpProcess?.kill('SIGKILL');
        resolve();
      }, 3000);
      mcpProcess?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
```

## 6. MCP Server Crash Recovery

The MCP server runs as a child process (`npx -y redalert-mcp-server`). If it crashes, the bot must recover.

### Strategy: Restart with Backoff

```typescript
// src/mcp-client.ts
class McpClientManager {
  private process: ChildProcess | null = null;
  private client: Client | null = null;
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private baseDelayMs = 1000; // 1s, 2s, 4s, 8s, 16s

  async spawn(): Promise<void> {
    this.process = spawn('npx', ['-y', 'redalert-mcp-server'], {
      env: { ...process.env, REDALERT_API_KEY: config.redAlertApiKey },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'MCP server process exited');
      this.handleCrash();
    });

    // Connect MCP client over stdio
    this.client = new Client({ name: 'redalert-bot', version: '1.0.0' });
    const transport = new StdioClientTransport({
      reader: this.process.stdout!,
      writer: this.process.stdin!,
    });
    await this.client.connect(transport);

    this.restartAttempts = 0; // Reset on successful connect
  }

  private async handleCrash(): Promise<void> {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error('MCP server max restart attempts reached. Giving up.');
      // Notify admin if configured
      return;
    }

    const delay = this.baseDelayMs * Math.pow(2, this.restartAttempts);
    this.restartAttempts++;
    logger.info({ attempt: this.restartAttempts, delayMs: delay }, 'Restarting MCP server');

    await new Promise(r => setTimeout(r, delay));
    await this.spawn();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('MCP client not connected');
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
```

Key behaviors:
- Exponential backoff: 1s, 2s, 4s, 8s, 16s
- Max 5 restart attempts before giving up
- Reset counter on successful reconnection
- Log every crash and restart attempt
- If `BOT_ADMIN_CHAT_ID` is set, send a Telegram message to the admin on crash

### During MCP Downtime

If a user sends a message while MCP is restarting, the bot replies with a temporary error message: "The alert service is temporarily restarting. Please try again in a few seconds."

## 7. Health Monitoring

### Telegram `/status` Command

The bot exposes a `/status` command that reports:

```
RedAlert Bot Status
---
Bot: Online
MCP Server: Connected (12 tools available)
Uptime: 2h 34m
Active users (last hour): 15
```

### Admin Notifications

If `BOT_ADMIN_CHAT_ID` is set, the bot sends proactive alerts for:
- MCP server crash/restart
- MCP server max restarts exhausted (critical)
- Startup success

No separate HTTP `/health` endpoint -- the bot is a long-polling Telegram client, not a web server. Adding an HTTP server just for health checks is unnecessary complexity. If external monitoring is needed later, a simple HTTP health endpoint can be added.

## 8. Logging Strategy

Structured JSON logs using a lightweight logger (e.g., `pino`).

### Log Format

```json
{
  "level": "info",
  "time": 1710000000000,
  "msg": "Handling user message",
  "userId": 123456,
  "chatId": 789012,
  "mcpTool": "get_active_alerts",
  "durationMs": 340
}
```

### What to Log

| Event | Level | Fields |
|-------|-------|--------|
| Bot started | `info` | uptime start |
| MCP server spawned | `info` | pid |
| MCP server crashed | `warn` | exit code, signal |
| MCP server restart failed | `error` | attempt count |
| User message received | `info` | userId, chatId |
| Claude API call | `debug` | model, token count |
| MCP tool called | `info` | tool name, duration |
| MCP tool error | `warn` | tool name, error |
| Rate limit hit | `warn` | userId |
| Shutdown initiated | `info` | signal |

### What NOT to Log

- Message content (privacy)
- API keys or tokens
- Full Claude API responses (too large)
- Full conversation history

### Log Dependencies

Use `pino` (fast, structured, JSON by default):

```json
{
  "dependencies": {
    "pino": "^9.0.0"
  }
}
```

In development, pipe through `pino-pretty` for human-readable output:

```bash
npm run dev | npx pino-pretty
```

## 9. Project Dependencies

```json
{
  "name": "redalert-telegram-bot",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=22" },
  "dependencies": {
    "telegraf": "^4.16.0",
    "@anthropic-ai/sdk": "^0.39.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "pino-pretty": "^13.0.0"
  }
}
```

## 10. Project File Structure (Ops-Relevant Files)

```
C:/redAlertBot/
  .env.example          # Template for environment variables
  .gitignore            # node_modules, dist, .env
  Dockerfile            # Multi-stage production build
  docker-compose.yml    # Local dev convenience
  package.json          # Scripts and dependencies
  tsconfig.json         # TypeScript config
  src/
    index.ts            # Entry point + graceful shutdown
    config.ts           # Env var loading and validation
    logger.ts           # Pino logger setup
    mcp-client.ts       # MCP child process + crash recovery
    bot.ts              # Telegraf setup + commands
    claude-bridge.ts    # Claude API + tool loop
    conversation.ts     # Per-user history management
    system-prompt.ts    # Bot system prompt
    rate-limiter.ts     # Per-user rate limiting
```

## 11. Startup Sequence

```
1. Load and validate config (exit 1 if missing required vars)
2. Initialize logger
3. Spawn MCP server child process
4. Connect MCP client, list available tools
5. Initialize Telegraf bot with commands
6. Register shutdown handlers (SIGTERM, SIGINT)
7. Start Telegraf long-polling
8. Log "Bot started" with tool count
9. Notify admin (if BOT_ADMIN_CHAT_ID set)
```

## 12. .gitignore

```
node_modules/
dist/
.env
*.log
```

## 13. tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```
