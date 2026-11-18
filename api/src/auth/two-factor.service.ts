import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import { encryptionSecrets, SecretBox } from '../common/secret-box.js';
import type { Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from './totp.js';

/** Two-factor sign-in with an authenticator app (TOTP) and single-use recovery codes. */
@Injectable()
export class TwoFactorService {
  private readonly box: SecretBox;
  /** ENCRYPTION_KEY first, then previous keys: codes hashed before a key rotation keep working. */
  private readonly codeKeys: string[];

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    const env = { ENCRYPTION_KEY: config.get('ENCRYPTION_KEY'), ENCRYPTION_KEY_PREVIOUS: config.get('ENCRYPTION_KEY_PREVIOUS') };
    this.box = new SecretBox('totp-secrets', encryptionSecrets(env));
    this.codeKeys = encryptionSecrets(env);
  }

  /**
   * Recovery codes carry 40 bits, too few to survive offline guessing with a plain hash, so they are
   * hashed with a server-side key: a leaked database alone does not reveal them.
   */
  private hashCode(userId: string, code: string, key = this.codeKeys[0]) {
    return createHmac('sha256', key).update(`${userId}:${normalizeRecoveryCode(code)}`).digest('hex');
  }

  /** Starts setup: stores a new secret (not active yet) and returns what the authenticator app needs. */
  async setup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.emailVerifiedAt) throw new ForbiddenException('Verify your email address before setting up two-factor authentication');
    if (user.totpEnabledAt) throw new BadRequestException('Two-factor authentication is already on');
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: this.box.encrypt(secret), totpLastStep: null } });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /** Confirms setup with a first code from the app and returns the recovery codes (shown once). */
  async enable(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw new BadRequestException('Two-factor authentication is already on');
    if (!user.totpSecret) throw new BadRequestException('Start the setup first');
    const step = verifyTotp(this.box.decrypt(user.totpSecret), code);
    if (step === null) throw new BadRequestException('That code is not valid. Check the time on your device and try again.');
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date(), totpLastStep: step } });
    return { recoveryCodes: await this.replaceRecoveryCodes(userId) };
  }

  /** Turns 2FA off; needs the password and a current code (or a recovery code). */
  async disable(userId: string, password: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt) throw new BadRequestException('Two-factor authentication is not on');
    if (!(await argon2.verify(user.passwordHash, password).catch(() => false))) throw new BadRequestException('Current password is incorrect');
    if (!(await this.verify(user, code))) throw new BadRequestException('That code is not valid');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
    ]);
  }

  async regenerateRecoveryCodes(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabledAt) throw new BadRequestException('Two-factor authentication is not on');
    if (!(await this.verifyTotpOnly(user, code))) throw new BadRequestException('That code is not valid');
    return { recoveryCodes: await this.replaceRecoveryCodes(userId) };
  }

  remainingRecoveryCodes(userId: string) {
    return this.prisma.recoveryCode.count({ where: { userId, usedAt: null } });
  }

  /** A six-digit app code, or a recovery code (used up on success). */
  async verify(user: User, code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) return this.verifyTotpOnly(user, trimmed);
    const used = await this.prisma.recoveryCode.updateMany({
      where: { userId: user.id, codeHash: { in: this.codeKeys.map((k) => this.hashCode(user.id, trimmed, k)) }, usedAt: null },
      data: { usedAt: new Date() },
    });
    return used.count === 1;
  }

  private async verifyTotpOnly(user: User, code: string): Promise<boolean> {
    if (!user.totpSecret || !user.totpEnabledAt) return false;
    const step = verifyTotp(this.box.decrypt(user.totpSecret), code.trim());
    if (step === null) return false;
    // Each code works once: only a step later than the last accepted one may be used (atomic, so
    // two parallel requests with the same code cannot both succeed).
    const claimed = await this.prisma.user.updateMany({
      where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return claimed.count === 1;
  }

  private async replaceRecoveryCodes(userId: string) {
    const codes = newRecoveryCodes();
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: this.hashCode(userId, c) })) }),
    ]);
    return codes;
  }
}
