import { Injectable } from '@nestjs/common';

import { Problems } from '../common/problem.js';

interface Window {
  startedAt: number;
  count: number;
}

/**
 * Fixed one-minute windows per key, kept in this API instance's memory
 * (ADR-006 consequences: a shared limiter arrives with the API gateway).
 * Bounds cost and abuse of the map and geocoding endpoints.
 */
@Injectable()
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private static readonly WINDOW_MS = 60_000;
  /** Above this many keys, expired windows are swept before adding another. */
  private static readonly SWEEP_AT = 10_000;

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one request; throws 429 with Retry-After when the key is over its limit. */
  take(key: string, limitPerMinute: number): void {
    const now = this.now();
    let window = this.windows.get(key);
    if (window === undefined || now - window.startedAt >= RateLimiter.WINDOW_MS) {
      if (window === undefined && this.windows.size >= RateLimiter.SWEEP_AT) this.sweep(now);
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= limitPerMinute) {
      throw Problems.tooManyRequests(Math.max(1, Math.ceil((window.startedAt + RateLimiter.WINDOW_MS - now) / 1000)));
    }
    window.count += 1;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= RateLimiter.WINDOW_MS) this.windows.delete(key);
    }
  }
}
