import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import type { Redis } from 'ioredis';

/**
 * Atomic fixed-window counter with a block period, the same rules as @nestjs/throttler's in-memory
 * storage: more than `limit` hits within `ttl` blocks the key for `blockDuration`.
 * Returns [hits, ms until the window resets, blocked (0/1), ms until the block ends].
 */
const INCREMENT = `
local hits_key, block_key = KEYS[1], KEYS[2]
local ttl, limit, block = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local blocked_for = redis.call('PTTL', block_key)
if blocked_for > 0 then
  return { tonumber(redis.call('GET', hits_key) or (limit + 1)), math.max(redis.call('PTTL', hits_key), 0), 1, blocked_for }
end
local hits = redis.call('INCR', hits_key)
if hits == 1 then redis.call('PEXPIRE', hits_key, ttl) end
local left = redis.call('PTTL', hits_key)
if hits > limit then
  redis.call('SET', block_key, 1, 'PX', block)
  return { hits, left, 1, block }
end
return { hits, left, 0, 0 }`;

/** Rate-limit counters shared by every API instance through Redis. */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const base = `throttle:${throttlerName}:${key}`;
    const block = blockDuration > 0 ? blockDuration : ttl;
    const [hits, left, blocked, blockLeft] = (await this.redis.eval(INCREMENT, 2, `${base}:hits`, `${base}:block`, ttl, limit, block)) as number[];
    return {
      totalHits: hits,
      timeToExpire: Math.ceil(left / 1000),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.ceil(blockLeft / 1000),
    };
  }
}
