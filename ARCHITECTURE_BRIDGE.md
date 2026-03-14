# Architecture: Claude API Bridge & Conversation Management

## Overview

This document defines how the Telegram bot bridges Claude API `tool_use` with MCP server tool calls, manages per-user conversations, and controls costs.

---

## 1. MCP Tool Schema → Claude API Tool Format

### The Problem

MCP tools are registered with Zod schemas. The MCP SDK's `client.listTools()` returns tools already in JSON Schema format (the MCP protocol uses JSON Schema, not Zod, on the wire). So we do **not** need to convert Zod → JSON Schema ourselves.

### Conversion at Startup

```typescript
// After MCP client connects, list tools once and cache
const { tools } = await mcpClient.listTools();

// Convert MCP tool list → Claude API tool definitions
const claudeTools: Anthropic.Tool[] = tools.map((tool) => ({
  name: tool.name,
  description: tool.description ?? "",
  input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
}));
```

The MCP `inputSchema` is already a JSON Schema object with `type: "object"` and `properties` — exactly what Claude API expects in `input_schema`.

### Tool Catalog (12 tools)

| MCP Tool Name | Parameters | Category |
|---|---|---|
| `health_check` | none | System |
| `get_active_alerts` | none | Alerts |
| `subscribe_alerts` | alertTypes?, testMode?, timing? | Real-time |
| `poll_alerts` | limit?, acknowledge? | Real-time |
| `unsubscribe_alerts` | none | Real-time |
| `get_alert_subscription_status` | none | Real-time |
| `get_cities` | search?, zone?, limit?, offset?, include? | Data |
| `search_shelters` | lat?, lon?, city?, limit?, radius?, wheelchairOnly?, shelterType? | Data |
| `get_stats_summary` | startDate?, endDate?, origin?, include?, topLimit?, timelineGroup? | Stats |
| `get_stats_cities` | startDate?, endDate?, limit?, offset?, origin?, search?, include? | Stats |
| `get_stats_history` | startDate?, endDate?, limit?, offset?, cityId?, cityName?, search?, category?, origin?, sort?, order?, include? | Stats |
| `get_stats_distribution` | startDate?, endDate?, origin?, groupBy?, category?, limit?, offset?, sort?, order? | Stats |

### Tool Filtering for Telegram Bot

Not all tools should be exposed to Telegram users. The real-time subscription tools (`subscribe_alerts`, `poll_alerts`, `unsubscribe_alerts`, `get_alert_subscription_status`) are designed for long-lived MCP sessions, not request/response Telegram interactions.

**Approach:** Maintain an allowlist of tools to expose to Claude:

```typescript
const ALLOWED_TOOLS = new Set([
  "health_check",
  "get_active_alerts",
  "get_cities",
  "search_shelters",
  "get_stats_summary",
  "get_stats_cities",
  "get_stats_history",
  "get_stats_distribution",
]);

const claudeTools = tools
  .filter((t) => ALLOWED_TOOLS.has(t.name))
  .map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
```

This gives us 8 tools. The real-time tools can be added later if we implement a push-notification feature.

---

## 2. Agentic Tool Execution Loop

### Flow

```
User message (Telegram)
    │
    ▼
┌─────────────────────┐
│ Build messages array │  ← system prompt + conversation history + new user message
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Claude API request   │  ← messages + tools
└─────────┬───────────┘
          │
          ▼
     ┌────┴────┐
     │ Has      │
     │ tool_use?│
     │          │
   Yes         No
     │          │
     ▼          ▼
┌──────────┐  ┌──────────────┐
│ Call MCP  │  │ Extract text │
│ tool(s)   │  │ Send to user │
└────┬─────┘  └──────────────┘
     │
     ▼
┌──────────────────────────┐
│ Append assistant + tool   │
│ results to messages       │
└────────────┬─────────────┘
             │
             ▼
        Loop back to Claude API request
```

### Implementation

```typescript
async function runAgenticLoop(
  anthropic: Anthropic,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  mcpClient: Client,
  maxIterations: number = 10,
): Promise<string> {
  for (let i = 0; i < maxIterations; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages,
      tools,
    });

    // Collect text and tool_use blocks
    const textParts: string[] = [];
    const toolUses: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text") textParts.push(block.text);
      if (block.type === "tool_use") toolUses.push(block);
    }

    // If no tool calls, we're done
    if (toolUses.length === 0 || response.stop_reason === "end_turn") {
      // Append assistant response to history
      messages.push({ role: "assistant", content: response.content });
      return textParts.join("\n");
    }

    // Append assistant response (with tool_use blocks) to history
    messages.push({ role: "assistant", content: response.content });

    // Execute tool calls via MCP and build tool results
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (toolUse) => {
        try {
          const result = await mcpClient.callTool({
            name: toolUse.name,
            arguments: toolUse.input as Record<string, unknown>,
          });
          // MCP returns { content: [{ type: "text", text: "..." }] }
          const text = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: text,
            is_error: result.isError ?? false,
          };
        } catch (error) {
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
            is_error: true,
          };
        }
      })
    );

    // Append tool results as a user message
    messages.push({ role: "user", content: toolResults });
  }

  return "I was unable to complete the request within the allowed number of steps. Please try a simpler question.";
}
```

### Key Design Decisions

- **Max 10 iterations**: Prevents runaway loops. Most queries need 1-2 tool calls.
- **Parallel tool calls**: If Claude requests multiple tools in one response, execute them concurrently with `Promise.all`.
- **Error isolation**: A single failing tool doesn't crash the loop. The error is returned to Claude as a `tool_result` with `is_error: true`, letting Claude recover gracefully.
- **MCP result format**: The MCP server returns `{ content: [{ type: "text", text: JSON.stringify(data) }] }`. We extract the text and pass it to Claude as-is.

---

## 3. Conversation History Management

### Per-User State

```typescript
interface UserConversation {
  messages: Anthropic.MessageParam[];
  lastActivity: number;       // timestamp
  totalTokensUsed: number;    // approximate, from Claude response usage
}

// In-memory store, keyed by Telegram user ID
const conversations = new Map<number, UserConversation>();
```

### Sliding Window Strategy

Claude Sonnet has a 200K context window but we want to keep costs low. Strategy:

1. **Max messages per conversation**: 40 messages (20 user/assistant pairs). This is roughly 30K-50K tokens depending on tool results.
2. **Trim strategy**: When the message count exceeds 40, remove the oldest user/assistant pair from the beginning (keeping the system prompt, which is sent separately).
3. **Token tracking**: Track `input_tokens` + `output_tokens` from each Claude response. If cumulative tokens for a conversation exceed 100K, trim more aggressively (drop to last 10 messages).
4. **TTL**: Conversations expire after 30 minutes of inactivity. A periodic cleanup (every 5 minutes) removes stale entries.

```typescript
function trimConversation(conv: UserConversation): void {
  const MAX_MESSAGES = 40;
  const AGGRESSIVE_TRIM_THRESHOLD = 100_000; // tokens

  if (conv.totalTokensUsed > AGGRESSIVE_TRIM_THRESHOLD) {
    // Keep only last 10 messages
    conv.messages = conv.messages.slice(-10);
    conv.totalTokensUsed = 0; // reset counter (approximation)
    return;
  }

  while (conv.messages.length > MAX_MESSAGES) {
    // Remove oldest pair (skip tool_result messages that belong to a pair)
    conv.messages.shift();
  }
}
```

### /clear Command

Users can send `/clear` to reset their conversation. This deletes their entry from the map entirely.

---

## 4. System Prompt

```typescript
export const SYSTEM_PROMPT = `You are RedAlert Bot, a Telegram assistant for Israel's emergency alert system (פיקוד העורף).

You help users check real-time alerts, find shelters, and get alert statistics.

## Capabilities
- Check active alerts right now (get_active_alerts)
- Find nearby shelters by city name or coordinates (search_shelters)
- Get alert statistics: summaries, city breakdowns, history, distributions
- Look up city information (get_cities)
- Check system health (health_check)

## Language
- Respond in the same language the user writes in.
- If the user writes in Hebrew, respond in Hebrew.
- If the user writes in English, respond in English.
- City names from the API are in Hebrew; include transliterations or translations when responding in English.

## Formatting
- Use Telegram-compatible formatting (Markdown V2 or plain text).
- Keep responses concise — this is a mobile messaging app.
- For shelter results, include distance and address.
- For alert lists, group by type when there are many.
- Use bullet points or numbered lists for readability.

## Safety
- If the user seems to be in immediate danger, always recommend calling emergency services (100 for police, 101 for MDA, 102 for fire).
- When sharing active alerts, include the recommended protective action if available.
- Do not speculate about future attacks or military operations.
- Do not provide advice that contradicts Home Front Command guidelines.

## Tool Usage
- Use get_active_alerts when asked about current/live/ongoing alerts.
- Use search_shelters when asked about shelters, safe rooms, or where to go.
- Use get_stats_summary for overview questions ("how many alerts this week?").
- Use get_stats_cities for city-specific stats.
- Use get_stats_history for detailed alert records.
- Use get_stats_distribution for breakdowns by type or origin.
- Use get_cities to look up city info, zones, or coordinates.
- If unsure which stats tool to use, start with get_stats_summary.
- Set appropriate date ranges — don't fetch all history when the user asks about "today" or "this week".
`;
```

---

## 5. Rate Limiting

### Per-User Limits

| Limit | Value | Purpose |
|---|---|---|
| Messages per minute | 5 | Prevent spam |
| Messages per hour | 30 | Cost control |
| Messages per day | 100 | Hard daily cap |

### Implementation

Use a simple sliding-window counter per user:

```typescript
interface RateLimitState {
  timestamps: number[]; // message timestamps
}

const rateLimits = new Map<number, RateLimitState>();

function checkRateLimit(userId: number): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const state = rateLimits.get(userId) ?? { timestamps: [] };

  // Clean old timestamps (older than 24h)
  state.timestamps = state.timestamps.filter((t) => now - t < 86_400_000);

  const lastMinute = state.timestamps.filter((t) => now - t < 60_000).length;
  const lastHour = state.timestamps.filter((t) => now - t < 3_600_000).length;
  const lastDay = state.timestamps.length;

  if (lastMinute >= 5) return { allowed: false, retryAfterSec: 60 };
  if (lastHour >= 30) return { allowed: false, retryAfterSec: 3600 };
  if (lastDay >= 100) return { allowed: false, retryAfterSec: 86400 };

  state.timestamps.push(now);
  rateLimits.set(userId, state);
  return { allowed: true };
}
```

### Rate Limit Responses

When rate-limited, the bot responds with a friendly message:

- Per-minute: "You're sending messages too fast. Please wait a moment."
- Per-hour: "You've reached the hourly message limit. Try again later."
- Per-day: "Daily limit reached. Come back tomorrow!"

---

## 6. Model Selection & Cost Optimization

### Single Model: Claude Sonnet 4

Use **claude-sonnet-4-20250514** for all queries. Rationale:

- Sonnet is the best balance of quality/cost/speed for tool use.
- Haiku is cheaper but struggles with complex multi-tool queries and Hebrew.
- Opus is overkill for this use case.
- A single model simplifies the architecture — no routing logic, no prompt variance.

### Cost Estimates

At Sonnet pricing (~$3/M input, $15/M output):
- Typical query (1 tool call): ~2K input + 500 output tokens = ~$0.01
- Complex query (3 tool calls, 3 loop iterations): ~8K input + 2K output = ~$0.05
- With rate limits (100 msg/user/day), worst case per user: ~$5/day

### Additional Cost Controls

1. **`max_tokens: 2048`**: Limit output per Claude call. Sufficient for formatted responses.
2. **Trim tool results**: If an MCP tool returns very large JSON (e.g., stats with 500 cities), truncate before sending to Claude. Cap at 50KB per tool result.
3. **Conversation trimming**: As described in section 3, aggressively trim when token usage is high.

```typescript
function truncateToolResult(text: string, maxBytes: number = 50_000): string {
  if (text.length <= maxBytes) return text;
  return text.slice(0, maxBytes) + "\n\n[Result truncated — too large to display in full]";
}
```

---

## 7. Error Handling in the Bridge

| Error | Handling |
|---|---|
| Claude API 429 (rate limit) | Retry once after `retry-after` header, then tell user to wait |
| Claude API 500/503 | Tell user "Service temporarily unavailable" |
| Claude API auth error | Log critical error, tell user "Bot configuration error" |
| MCP tool timeout (>15s) | Return tool error to Claude, let it respond gracefully |
| MCP server disconnected | Attempt reconnect (handled by mcp-client module), queue message |
| Invalid tool arguments from Claude | Caught by MCP server validation, returned as tool error |
| Conversation too large | Trim and retry |

---

## 8. File Structure (Bridge Components)

```
C:/redAlertBot/src/
  claude-bridge.ts      # Claude API client, tool conversion, agentic loop
  conversation.ts       # Per-user conversation store, trimming, TTL cleanup
  system-prompt.ts      # System prompt constant
  rate-limiter.ts       # Per-user rate limiting
```

---

## 9. Integration with Bot Core

The bot's message handler calls the bridge:

```typescript
// In bot.ts message handler
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Check rate limit
  const rateCheck = checkRateLimit(userId);
  if (!rateCheck.allowed) {
    await ctx.reply(getRateLimitMessage(rateCheck.retryAfterSec));
    return;
  }

  // Get or create conversation
  const conv = getOrCreateConversation(userId);

  // Add user message
  conv.messages.push({ role: "user", content: text });

  // Run agentic loop
  await ctx.sendChatAction("typing");
  const response = await runAgenticLoop(anthropic, conv.messages, claudeTools, mcpClient);

  // Send response (split if >4096 chars for Telegram limit)
  await sendLongMessage(ctx, response);

  // Update conversation state
  conv.lastActivity = Date.now();
  trimConversation(conv);
});
```

### Typing Indicator

Send `typing` chat action before the Claude call. For long-running multi-tool queries, refresh the typing indicator every 5 seconds using a timer that runs during the agentic loop.
