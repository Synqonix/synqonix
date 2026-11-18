import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { HOLD, RunOnce } from '../redis/job-lock.js';
import type { Env } from '../config/env.js';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY = 86_400_000;

export interface RetentionResult {
  auditLogs: number; notifications: number; webhookDeliveries: number; githubDeliveries: number;
  unverifiedSignups: number; loginThrottles: number;
}

/** Sign-ups whose email link was never used are removed after this long (they never got to do anything). */
export const UNVERIFIED_SIGNUP_DAYS = 7;

/** Nightly cleanup of records that only matter for a while. A setting of 0 days keeps that kind forever. */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly throttles: LoginThrottleService,
  ) {}

  async run(now = new Date()): Promise<RetentionResult> {
    const before = (days: number) => new Date(now.getTime() - days * DAY);
    const audit = this.config.get('AUDIT_RETENTION_DAYS');
    const notes = this.config.get('NOTIFICATION_RETENTION_DAYS');
    const deliveries = this.config.get('DELIVERY_RETENTION_DAYS');
    return {
      auditLogs: audit ? (await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: before(audit) } } })).count : 0,
      // Unread notifications stay; only ones already read go.
      notifications: notes ? (await this.prisma.notification.deleteMany({ where: { readAt: { not: null, lt: before(notes) } } })).count : 0,
      // Deliveries still waiting for a retry are never purged.
      webhookDeliveries: deliveries ? (await this.prisma.outboundDelivery.deleteMany({ where: { status: { not: 'PENDING' }, createdAt: { lt: before(deliveries) } } })).count : 0,
      githubDeliveries: deliveries ? (await this.prisma.webhookDelivery.deleteMany({ where: { receivedAt: { lt: before(deliveries) } } })).count : 0,
      // Accounts from before sign-up required verification may be unverified but in use: only remove
      // ones that never joined anything or signed in.
      unverifiedSignups: (await this.prisma.user.deleteMany({
        where: { emailVerifiedAt: null, createdAt: { lt: before(UNVERIFIED_SIGNUP_DAYS) }, memberships: { none: {} }, sessions: { none: {} } },
      })).count,
      loginThrottles: (await this.throttles.prune(now)).count,
    };
  }

  @Cron('17 3 * * *')
  @RunOnce('retention', HOLD.day)
  async nightly() {
    try {
      const r = await this.run();
      this.logger.log(`Retention cleanup removed ${JSON.stringify(r)}`);
    } catch (err) {
      this.logger.error('Retention cleanup failed', err as Error);
    }
  }
}
