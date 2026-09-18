import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryRateLimiter } from '@/lib/security/rate-limiter';

describe('Sliding Window Rate Limiter', () => {
  let limiter: MemoryRateLimiter;

  beforeEach(() => {
    limiter = new MemoryRateLimiter();
  });

  it('allows requests within threshold limit', () => {
    const key = 'test_ip_1';
    for (let i = 0; i < 5; i++) {
      const res = limiter.check(key, 5, 10);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(4 - i);
    }
  });

  it('blocks requests once limit is exceeded within window', () => {
    const key = 'test_ip_2';
    // Consume 3 allowed tokens
    limiter.check(key, 3, 10);
    limiter.check(key, 3, 10);
    limiter.check(key, 3, 10);

    // 4th request should be blocked
    const res = limiter.check(key, 3, 10);
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.resetInSeconds).toBeGreaterThan(0);
  });

  it('resets counter when key or store is cleared', () => {
    const key = 'test_ip_3';
    limiter.check(key, 1, 10);
    expect(limiter.check(key, 1, 10).allowed).toBe(false);

    limiter.reset(key);
    expect(limiter.check(key, 1, 10).allowed).toBe(true);
  });
});
