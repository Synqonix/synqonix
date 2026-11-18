/** A token bucket: `capacity` actions at once, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Takes `cost` tokens if available. */
  take(cost = 1, now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Counts events per key in a fixed window (used for handshakes per client address). */
export class WindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records one hit; false when the key is over its limit for the current window. */
  hit(key: string, now = Date.now()): boolean {
    if (this.hits.size >= this.maxKeys) this.sweep(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    // Still full of live keys: drop the oldest so memory stays bounded.
    if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
  }
}
