import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TIMEOUT_MS, runAt } from './long-timeout.js';

describe('runAt', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for times further away than setTimeout can hold, instead of firing at once', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const ninetyDays = 90 * 24 * 3600_000;
    runAt(Date.now() + ninetyDays, fn);
    vi.advanceTimersByTime(1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMEOUT_MS);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ninetyDays);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('runs at once for a past time and can be cancelled', () => {
    vi.useFakeTimers();
    const past = vi.fn();
    runAt(Date.now() - 1, past);
    expect(past).toHaveBeenCalledOnce();
    const later = vi.fn();
    const cancel = runAt(Date.now() + 1000, later);
    cancel();
    vi.advanceTimersByTime(2000);
    expect(later).not.toHaveBeenCalled();
  });
});
