import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkRateLimit,
  getRateLimitMessage,
  clearRateLimit,
  cleanupRateLimits,
} from "../rate-limiter.js";

describe("rate-limiter", () => {
  beforeEach(() => {
    clearRateLimit(1);
    clearRateLimit(2);
    vi.restoreAllMocks();
  });

  describe("checkRateLimit", () => {
    it("allows requests under the per-minute limit", () => {
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit(1)).toEqual({ allowed: true });
      }
    });

    it("blocks after 5 requests per minute", () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit(1);
      }
      const result = checkRateLimit(1);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSec).toBe(60);
    });

    it("tracks users independently", () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit(1);
      }
      expect(checkRateLimit(1).allowed).toBe(false);
      expect(checkRateLimit(2).allowed).toBe(true);
    });

    it("blocks after 30 requests per hour", () => {
      const now = Date.now();
      // Spread 30 requests across the hour (not all in one minute)
      vi.spyOn(Date, "now");
      for (let i = 0; i < 30; i++) {
        // Each request 2 minutes apart (120,000ms) so they don't hit per-minute limit
        vi.mocked(Date.now).mockReturnValue(now + i * 120_000);
        checkRateLimit(1);
      }
      vi.mocked(Date.now).mockReturnValue(now + 30 * 120_000);
      // 31st request within the hour window should be blocked by hourly limit
      // Actually 30*120_000 = 3,600,000 = exactly 1 hour, so all 30 timestamps
      // are within the hour window at that moment. Let's use slightly shorter spacing.
      clearRateLimit(1);

      vi.mocked(Date.now).mockReturnValue(now);
      // Send 30 requests spaced 61 seconds apart to avoid per-minute limit
      for (let i = 0; i < 30; i++) {
        vi.mocked(Date.now).mockReturnValue(now + i * 61_000);
        const r = checkRateLimit(1);
        expect(r.allowed).toBe(true);
      }

      // 31st request still within the hour for many of them
      vi.mocked(Date.now).mockReturnValue(now + 30 * 61_000);
      const result = checkRateLimit(1);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSec).toBe(3600);
    });

    it("blocks after 100 requests per day", () => {
      const now = Date.now();
      vi.spyOn(Date, "now");
      clearRateLimit(1);

      // Space at ~14 min apart: 100 * 860_000 = 86_000_000 < 86_400_000 (1 day)
      // ~4 per hour, well under the 30/hr limit; 1 per 14min, well under 5/min
      for (let i = 0; i < 100; i++) {
        vi.mocked(Date.now).mockReturnValue(now + i * 860_000);
        const r = checkRateLimit(1);
        expect(r.allowed).toBe(true);
      }

      // 101st request - all 100 still within 24h window
      vi.mocked(Date.now).mockReturnValue(now + 100 * 860_000);
      const result = checkRateLimit(1);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSec).toBe(86400);
    });
  });

  describe("getRateLimitMessage", () => {
    it("returns minute message for short retry", () => {
      const msg = getRateLimitMessage(60);
      expect(msg).toContain("too fast");
    });

    it("returns hourly message", () => {
      const msg = getRateLimitMessage(3600);
      expect(msg).toContain("hourly");
    });

    it("returns daily message", () => {
      const msg = getRateLimitMessage(86400);
      expect(msg).toContain("Daily");
    });

    it("returns minute message for undefined", () => {
      const msg = getRateLimitMessage(undefined);
      expect(msg).toContain("too fast");
    });
  });

  describe("cleanupRateLimits", () => {
    it("removes users with no recent timestamps", () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      checkRateLimit(1);

      // Advance past 24h
      vi.mocked(Date.now).mockReturnValue(now + 86_400_001);
      cleanupRateLimits();

      // User should be cleaned up, so next request is allowed
      vi.mocked(Date.now).mockReturnValue(now + 86_400_001);
      expect(checkRateLimit(1).allowed).toBe(true);
    });
  });
});
