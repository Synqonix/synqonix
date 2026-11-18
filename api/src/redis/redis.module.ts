import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import { JobLock } from './job-lock.js';

import { REDIS } from './redis.tokens.js';

export { REDIS };

/** Builds a client for REDIS_URL with the key prefix, or null. */
export function createRedis(url: string | undefined, prefix: string): Redis | null {
  if (!url) return null;
  return new Redis(url, { keyPrefix: prefix, maxRetriesPerRequest: 3, lazyConnect: false });
}

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}
  async onApplicationShutdown() {
    await this.redis?.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const redis = createRedis(config.get('REDIS_URL'), config.get('REDIS_PREFIX'));
        if (redis) {
          const log = new Logger('Redis');
          redis.on('error', (err) => log.error(`Redis error: ${err.message}`));
        }
        return redis;
      },
    },
    JobLock,
    RedisShutdown,
  ],
  exports: [REDIS, JobLock],
})
export class RedisModule {}
