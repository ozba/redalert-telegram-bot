const LIMITS = {
  perMinute: 5,
  perHour: 30,
  perDay: 100,
} as const;

const WINDOWS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

interface RateLimitState {
  timestamps: number[];
}

const rateLimits = new Map<number, RateLimitState>();

export function checkRateLimit(
  userId: number,
): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const state = rateLimits.get(userId) ?? { timestamps: [] };

  // Clean timestamps older than 24h
  state.timestamps = state.timestamps.filter((t) => now - t < WINDOWS.day);

  const lastMinute = state.timestamps.filter(
    (t) => now - t < WINDOWS.minute,
  ).length;
  const lastHour = state.timestamps.filter(
    (t) => now - t < WINDOWS.hour,
  ).length;
  const lastDay = state.timestamps.length;

  if (lastMinute >= LIMITS.perMinute) {
    return { allowed: false, retryAfterSec: 60 };
  }
  if (lastHour >= LIMITS.perHour) {
    return { allowed: false, retryAfterSec: 3600 };
  }
  if (lastDay >= LIMITS.perDay) {
    return { allowed: false, retryAfterSec: 86400 };
  }

  state.timestamps.push(now);
  rateLimits.set(userId, state);
  return { allowed: true };
}

export function getRateLimitMessage(retryAfterSec?: number): string {
  if (!retryAfterSec || retryAfterSec <= 60) {
    return "You're sending messages too fast. Please wait a moment.";
  }
  if (retryAfterSec <= 3600) {
    return "You've reached the hourly message limit. Try again later.";
  }
  return "Daily limit reached. Come back tomorrow!";
}

export function clearRateLimit(userId: number): void {
  rateLimits.delete(userId);
}

export function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [userId, state] of rateLimits) {
    state.timestamps = state.timestamps.filter((t) => now - t < WINDOWS.day);
    if (state.timestamps.length === 0) {
      rateLimits.delete(userId);
    }
  }
}
