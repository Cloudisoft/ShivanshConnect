import { describe, expect, it, vi } from 'vitest';
import { SwrCache } from './swrCache.js';

describe('SwrCache', () => {
  it('computes once, then serves the cached value while fresh', async () => {
    const cache = new SwrCache<number>(1_000, 10_000);
    const compute = vi.fn().mockResolvedValue(1);
    expect(await cache.get('k', compute)).toBe(1);
    expect(await cache.get('k', compute)).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('serves a stale value immediately and refreshes it in the background', async () => {
    vi.useFakeTimers();
    try {
      const cache = new SwrCache<number>(1_000, 10_000);
      await cache.get('k', async () => 1);
      vi.advanceTimersByTime(2_000);
      const refresh = vi.fn().mockResolvedValue(2);
      expect(await cache.get('k', refresh)).toBe(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(await cache.get('k', refresh)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one in-flight computation between concurrent callers', async () => {
    const cache = new SwrCache<number>(1_000, 10_000);
    let resolve!: (v: number) => void;
    const compute = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const a = cache.get('k', compute);
    const b = cache.get('k', compute);
    resolve(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
