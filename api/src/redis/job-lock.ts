import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS } from './redis.tokens.js';

/** Extends the lock only while we still own it (it may have expired and been taken by another instance). */
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

/**
 * Runs scheduled jobs once across all API instances. Every instance's timer fires; the first to
 * take the lock for that run does the work, the others skip it. Without Redis (one instance) the
 * job simply runs.
 */
@Injectable()
export class JobLock {
  private readonly logger = new Logger(JobLock.name);
  /** The app's instance, for @RunOnce (decorators cannot use dependency injection). */
  static current: JobLock | undefined;

  constructor(@Inject(REDIS) private readonly redis: Redis | null) {
    JobLock.current = this;
  }

  /**
   * `holdMs` should be a bit shorter than the job's interval, so the next run is not blocked, and
   * longer than the gap between instances' clocks, so a slower instance does not run it again.
   */
  async runOnce<T>(name: string, holdMs: number, job: () => Promise<T>, maxRunMs = Math.max(holdMs * 10, 10 * 60_000)): Promise<T | undefined> {
    if (!this.redis) return job();
    const key = `lock:job:${name}`;
    const token = randomUUID();
    const got = await this.redis.set(key, token, 'PX', holdMs, 'NX');
    if (got !== 'OK') {
      this.logger.debug(`Skipping ${name}: another instance runs it`);
      return undefined;
    }
    // While the job runs, keep pushing the expiry out so a long run is never taken over halfway.
    // When it ends the lock is left to expire on its own, so instances whose timer fires a little
    // later still skip this run.
    // Only up to `maxRunMs`: a job that hangs must not keep the lock (and so block every later run
    // on every instance) forever; past that the lock lapses and the next run can start.
    const startedAt = Date.now();
    const renew = setInterval(() => {
      if (Date.now() - startedAt > maxRunMs) {
        clearInterval(renew);
        this.logger.warn(`${name} has been running for over ${Math.round(maxRunMs / 1000)}s; letting its lock lapse`);
        return;
      }
      void this.redis!.eval(RENEW, 1, key, token, holdMs).catch((err: Error) => this.logger.warn(`Could not renew ${key}: ${err.message}`));
    }, Math.max(1000, Math.floor(holdMs / 3)));
    try {
      return await job();
    } finally {
      clearInterval(renew);
    }
  }
}

/**
 * Makes a scheduled method run on one instance only. Put it directly above the method and below
 * `@Cron(...)`, so the schedule is attached to the wrapped method.
 */
export function RunOnce(name: string, holdMs: number): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      const lock = JobLock.current;
      return lock ? lock.runOnce(name, holdMs, () => original.apply(this, args)) : original.apply(this, args);
    };
    return descriptor;
  };
}

export const HOLD = { minute: 50_000, fiveMinutes: 4 * 60_000, hour: 50 * 60_000, day: 60 * 60_000 } as const;
