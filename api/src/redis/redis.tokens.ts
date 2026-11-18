/** The shared Redis client (ioredis), or null when REDIS_URL is unset (single instance: everything stays in memory). */
export const REDIS = Symbol('REDIS');
