import { Controller, Get, Header, Headers, Inject, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../common/decorators.js';
import { metrics } from '../common/observability.js';
import type { Env } from '../config/env.js';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS } from '../redis/redis.tokens.js';

@ApiTags('health')
@SkipThrottle()
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  /** Readiness: the database answers. Kept at `/health` for existing probes. */
  @Get('health')
  async check() {
    return this.ready();
  }

  /** Liveness: the process is up and serving; deliberately independent of the database. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the database (and Redis, when configured) answers. */
  @Get('health/ready')
  async ready() {
    const db = await this.prisma.$queryRaw`SELECT 1`.then(() => 'up', () => 'down');
    const redis = this.redis ? await this.redis.ping().then(() => 'up', () => 'down') : undefined;
    if (db === 'down' || redis === 'down') throw new ServiceUnavailableException({ status: 'error', db, ...(redis && { redis }) });
    return { status: 'ok', db, ...(redis && { redis }), uptime: process.uptime() };
  }

  /** Prometheus metrics; off unless METRICS_TOKEN is set, then bearer-protected. */
  @Get('metrics')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(@Headers('authorization') auth?: string) {
    const token = this.config.get('METRICS_TOKEN', { infer: true });
    if (!token) throw new NotFoundException();
    const given = Buffer.from((auth ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new UnauthorizedException();
    return metrics.render();
  }
}
