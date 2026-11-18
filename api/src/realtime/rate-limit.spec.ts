import { describe, expect, it } from 'vitest';
import { TokenBucket, WindowCounter } from './rate-limit.js';

describe('TokenBucket', () => {
  it('allows a burst then refuses until refilled', () => {
    const b = new TokenBucket(3, 1, 0);
    expect([b.take(1, 0), b.take(1, 0), b.take(1, 0), b.take(1, 0)]).toEqual([true, true, true, false]);
    expect(b.take(1, 1000)).toBe(true);
    expect(b.take(1, 1000)).toBe(false);
  });

  it('refuses a cost above what is available', () => {
    const b = new TokenBucket(5, 1, 0);
    expect(b.take(5, 0)).toBe(true);
    expect(b.take(2, 1000)).toBe(false);
  });
});

describe('WindowCounter', () => {
  it('limits per key within a window and resets after it', () => {
    const c = new WindowCounter(2, 1000);
    expect([c.hit('a', 0), c.hit('a', 1), c.hit('a', 2)]).toEqual([true, true, false]);
    expect(c.hit('b', 2)).toBe(true);
    expect(c.hit('a', 1001)).toBe(true);
  });

  it('stays bounded', () => {
    const c = new WindowCounter(1, 1000, 3);
    for (let i = 0; i < 10; i++) c.hit(`k${i}`, 0);
    expect(c.hit('k9', 0)).toBe(false);
  });
});
