import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;

/**
 * Per-account sign-in lockout, on top of the per-IP rate limit: after MAX_FAILURES wrong passwords
 * or codes within WINDOW_MS, sign-in for that email is refused for LOCK_MS (resetting the password
 * still works). Counted per email address whether or not an account exists, so a lockout does not
 * reveal which addresses are registered. Stored in Postgres so every API instance agrees.
 */
@Injectable()
export class LoginThrottleService {
  constructor(private readonly prisma: PrismaService) {}

  async assertNotLocked(email: string, now = new Date()) {
    const row = await this.prisma.loginThrottle.findUnique({ where: { email } });
    if (row?.lockedUntil && row.lockedUntil > now) {
      const minutes = Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 60_000);
      throw new HttpException(
        { statusCode: 429, code: 'ACCOUNT_LOCKED', message: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Records a failed attempt; returns true when this attempt locked the account. */
  async fail(email: string, now = new Date()): Promise<boolean> {
    const cutoff = new Date(now.getTime() - WINDOW_MS);
    // One atomic statement, so concurrent failures are all counted.
    const [row] = await this.prisma.$queryRaw<{ failures: number }[]>`
      INSERT INTO "LoginThrottle" ("email", "failures", "windowStart") VALUES (${email}, 1, ${now})
      ON CONFLICT ("email") DO UPDATE SET
        "failures" = CASE WHEN "LoginThrottle"."windowStart" < ${cutoff} THEN 1 ELSE "LoginThrottle"."failures" + 1 END,
        "windowStart" = CASE WHEN "LoginThrottle"."windowStart" < ${cutoff} THEN ${now} ELSE "LoginThrottle"."windowStart" END
      RETURNING "failures"`;
    if (row.failures < MAX_FAILURES) return false;
    await this.prisma.loginThrottle.update({
      where: { email },
      data: { failures: 0, windowStart: now, lockedUntil: new Date(now.getTime() + LOCK_MS) },
    });
    return true;
  }

  /** `key` is an email, or `email#device` for a device that signed in to the account before. */
  clear(key: string) {
    return this.prisma.loginThrottle.deleteMany({ where: { email: key } });
  }

  /** Every counter for an email (after a password reset or verification). */
  clearAll(email: string) {
    return this.prisma.loginThrottle.deleteMany({ where: { OR: [{ email }, { email: { startsWith: `${email}#` } }] } });
  }

  /** Rows nobody needs any more (called by the nightly cleanup). */
  prune(now = new Date()) {
    return this.prisma.loginThrottle.deleteMany({
      where: { windowStart: { lt: new Date(now.getTime() - 24 * 3600_000) }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    });
  }
}
