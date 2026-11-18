import { NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';
import type { Redis } from 'ioredis';
import type { PrismaService } from '../prisma/prisma.service.js';

const make = (query: () => Promise<unknown>, metricsToken?: string, redisPing?: () => Promise<unknown>) =>
  new HealthController(
    { $queryRaw: query } as unknown as PrismaService,
    { get: () => metricsToken } as unknown as ConfigService<never, true>,
    (redisPing ? { ping: redisPing } : null) as unknown as Redis | null,
  );

describe('HealthController', () => {
  it('reports ok when the database responds', async () => {
    const res = await make(vi.fn().mockResolvedValue([1])).check();
    expect(res).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('throws 503 when the database is down', async () => {
    await expect(
      make(vi.fn().mockRejectedValue(new Error('down'))).check(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('includes Redis when configured, and is not ready without it', async () => {
    const ok = vi.fn().mockResolvedValue([1]);
    expect(await make(ok, undefined, vi.fn().mockResolvedValue('PONG')).check()).toMatchObject({ db: 'up', redis: 'up' });
    await expect(make(ok, undefined, vi.fn().mockRejectedValue(new Error('down'))).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await make(ok).check()).not.toHaveProperty('redis');
  });

  it('liveness does not touch the database', () => {
    const query = vi.fn();
    expect(make(query).live()).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('metrics are off without a token, and need the right one with it', () => {
    expect(() => make(vi.fn()).metrics('Bearer anything')).toThrow(NotFoundException);
    const c = make(vi.fn(), 'm'.repeat(20));
    expect(() => c.metrics()).toThrow(UnauthorizedException);
    expect(() => c.metrics('Bearer nope')).toThrow(UnauthorizedException);
    expect(c.metrics(`Bearer ${'m'.repeat(20)}`)).toContain('synqonix_http_requests_total');
  });
});
