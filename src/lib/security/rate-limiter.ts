export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}

interface RateLimitRecord {
  timestamps: number[];
}

export class MemoryRateLimiter {
  private store: Map<string, RateLimitRecord> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Periodic sweep of idle keys every 5 minutes
    if (typeof setInterval !== 'undefined') {
      this.cleanupInterval = setInterval(() => this.sweep(), 5 * 60 * 1000);
      if (this.cleanupInterval.unref) {
        this.cleanupInterval.unref();
      }
    }
  }

  /**
   * Checks if a request for the given key is within the rate limit window
   */
  public check(key: string, maxRequests = 60, windowSeconds = 60): RateLimitResult {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;

    let record = this.store.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.store.set(key, record);
    }

    // Filter timestamps within the current sliding window
    record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

    if (record.timestamps.length >= maxRequests) {
      const oldestInWindow = record.timestamps[0];
      const resetInSeconds = Math.ceil((oldestInWindow + windowMs - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetInSeconds: Math.max(resetInSeconds, 1),
      };
    }

    record.timestamps.push(now);
    const remaining = maxRequests - record.timestamps.length;
    return {
      allowed: true,
      remaining,
      resetInSeconds: windowSeconds,
    };
  }

  public reset(key?: string): void {
    if (key) {
      this.store.delete(key);
    } else {
      this.store.clear();
    }
  }

  private sweep(): void {
    const now = Date.now();
    const maxAge = 15 * 60 * 1000; // 15 mins
    for (const [key, record] of this.store.entries()) {
      if (record.timestamps.length === 0 || now - record.timestamps[record.timestamps.length - 1] > maxAge) {
        this.store.delete(key);
      }
    }
  }
}

export const globalRateLimiter = new MemoryRateLimiter();
