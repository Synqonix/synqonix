import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import { randomToken, sha256 } from '../common/crypto.js';
import type { Env } from '../config/env.js';
import type { EmailToken, User } from '../generated/prisma/client.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { describeUserAgent } from './device.js';
import { AuthEvents, sessionCredentialId, type CredentialsRevokedEvent } from './events.js';
import type { AuthResponseDto, SessionDto, UserDto } from './dto/auth.dto.js';
import { JwtKeyRing, previousSecrets } from './jwt-keys.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { TwoFactorService } from './two-factor.service.js';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the "enter your 2FA code" step stays open after the password was accepted. */
const MFA_TTL_SECONDS = 5 * 60;

export interface ClientInfo {
  userAgent?: string;
  ip?: string;
  /** Value of the device cookie, when the browser has one. */
  deviceId?: string;
}

/**
 * What the service issues. The controller decides whether the refresh token goes in the body or
 * only in the cookie, and turns `deviceId` into the device cookie.
 */
export type IssuedTokens = AuthResponseDto & { refreshToken: string; deviceId?: string };
/** `nonce` goes into the registering browser's cookie (also when nothing was registered, so responses look alike). */
export type RegisterResult = IssuedTokens | { verificationSent: true; nonce: string };
/** The link was opened somewhere other than the registering browser: the clicker must choose the password. */
export type VerifyResult = IssuedTokens | { passwordRequired: true };
export type LoginResult = IssuedTokens | { mfaRequired: true; mfaToken: string };

interface RefreshPayload {
  sub: string;
  sid: string;
  jti: string;
}

export const toUserDto = (u: User): UserDto => ({
  id: u.id,
  email: u.email,
  name: u.name,
  emailVerified: u.emailVerifiedAt !== null,
  twoFactorEnabled: u.totpEnabledAt !== null,
  createdAt: u.createdAt,
});

/** A separate signing key for the 2FA step, so its token can never pass as an access token. */
const mfaSecret = (accessSecret: string) => createHash('sha256').update(`mfa-step:${accessSecret}`).digest('hex');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessKeys: JwtKeyRing;
  private readonly refreshKeys: JwtKeyRing;
  private readonly mfaKeys: JwtKeyRing;
  private readonly accessTtl: number;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    jwt: JwtService,
    private readonly mail: MailService,
    private readonly throttle: LoginThrottleService,
    private readonly twoFactor: TwoFactorService,
    private readonly events: EventEmitter2,
    config: ConfigService<Env, true>,
  ) {
    const accessPrevious = previousSecrets(config.get('JWT_ACCESS_SECRET_PREVIOUS'));
    this.accessKeys = new JwtKeyRing(jwt, config.get('JWT_ACCESS_SECRET'), accessPrevious);
    this.refreshKeys = new JwtKeyRing(jwt, config.get('JWT_REFRESH_SECRET'), previousSecrets(config.get('JWT_REFRESH_SECRET_PREVIOUS')));
    this.mfaKeys = new JwtKeyRing(jwt, mfaSecret(config.get('JWT_ACCESS_SECRET')), accessPrevious.map(mfaSecret));
    this.accessTtl = config.get('JWT_ACCESS_TTL_SECONDS');
    this.refreshTtlDays = config.get('REFRESH_TTL_DAYS');
  }

  get refreshMaxAgeMs() {
    return this.refreshTtlDays * DAY_MS;
  }

  // ---------- registration & login ----------

  /**
   * Always answers "check your inbox" (so it does not reveal which emails have accounts) and signs
   * in only once the emailed link is used. The exception is an invitation link: it was emailed to
   * this address, which proves ownership, so that registration signs in straight away.
   */
  async register(
    input: { email: string; name: string; password: string; invitationToken?: string },
    client: ClientInfo,
  ): Promise<RegisterResult> {
    const name = input.name.trim();
    // Hash first in every branch so response times do not reveal which branch ran.
    const passwordHash = await argon2.hash(input.password);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });

    if (existing?.emailVerifiedAt) {
      // After the response, like the verification mail below: whether mail goes out must not change how long this takes.
      void this.mail.sendAccountExistsEmail(existing);
      return { verificationSent: true, nonce: randomToken() };
    }

    if (input.invitationToken && (await this.invitationFor(input.invitationToken, input.email))) {
      const data = { name, passwordHash, emailVerifiedAt: new Date() };
      let user: User;
      if (existing) {
        // Claiming an address someone registered first: nothing they set up may remain.
        [user] = await this.prisma.$transaction([
          this.prisma.user.update({ where: { id: existing.id }, data: { ...data, ...NO_TOTP } }),
          ...this.evictionOps(existing.id),
        ]);
      } else {
        user = await this.prisma.user.create({ data: { email: input.email, ...data } });
      }
      return this.startSession(user, client, { notifyNewDevice: false });
    }

    // Unverified accounts keep their stored password until a link is used. The password chosen here
    // travels with the link but only applies in this browser (nonce cookie); opened anywhere else,
    // the link asks for a password, so whoever registered an address first never controls it.
    const user = existing ?? (await this.prisma.user.create({ data: { email: input.email, name, passwordHash } }));
    const nonce = randomToken();
    const token = await this.createEmailToken(user.id, 'VERIFY_EMAIL', VERIFY_TTL_MS, {
      pendingPasswordHash: passwordHash, pendingName: name, pendingNonceHash: sha256(nonce),
    });
    // Delivery is the slow part and happens after the response, as for an address that already has an account.
    void this.mail.sendVerificationEmail({ email: user.email, name }, token);
    return { verificationSent: true, nonce };
  }

  private async invitationFor(token: string, email: string) {
    const inv = await this.prisma.invitation.findUnique({ where: { tokenHash: sha256(token) } });
    const usable = inv && !inv.revokedAt && !inv.acceptedAt && inv.expiresAt > new Date();
    return usable && inv.email.toLowerCase() === email.toLowerCase() ? inv : null;
  }

  async login(input: { email: string; password: string }, client: ClientInfo): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const key = await this.throttleKey(input.email, user, client);
    await this.throttle.assertNotLocked(key);
    // Always run a hash verification so timing does not reveal whether the account exists.
    const ok = await argon2
      .verify(user?.passwordHash ?? (await getDummyHash()), input.password)
      .catch(() => false);
    if (!user || !ok) {
      await this.throttle.fail(key);
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.emailVerifiedAt) {
      // Only someone who knows the password gets here, so saying so reveals nothing new. No new link
      // is sent from here: that would replace the link a real owner's registration carries (with
      // their password) by one that keeps whoever registered first's password.
      throw new ForbiddenException({
        statusCode: 403, code: 'EMAIL_NOT_VERIFIED',
        message: 'This email address is not verified yet. Use the link we emailed you, or register again to get a new one.',
      });
    }
    if (user.totpEnabledAt) {
      const mfaToken = await this.mfaKeys.sign({ sub: user.id, purpose: 'mfa', fp: mfaFingerprint(user) }, MFA_TTL_SECONDS);
      // The counter is only reset by a complete sign-in, so wrong codes keep counting across retries.
      return { mfaRequired: true, mfaToken };
    }
    await this.throttle.clear(key);
    return this.startSession(user, client, { notifyNewDevice: true });
  }

  /** Second step of a sign-in with 2FA: an authenticator code or a recovery code. */
  async loginWithSecondFactor(mfaToken: string, code: string, client: ClientInfo): Promise<IssuedTokens> {
    const expired = new UnauthorizedException('This sign-in has expired. Start again.');
    const payload = await this.mfaKeys.verify<{ sub: string; purpose: string; fp?: string }>(mfaToken);
    if (!payload || payload.purpose !== 'mfa') throw expired;
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    // The step dies when the password or the 2FA setup changed since the password was checked.
    if (!user?.totpEnabledAt || payload.fp !== mfaFingerprint(user)) throw expired;
    const key = await this.throttleKey(user.email, user, client);
    await this.throttle.assertNotLocked(key);
    if (!(await this.twoFactor.verify(user, code))) {
      await this.throttle.fail(key);
      throw new UnauthorizedException('That code is not valid');
    }
    await this.throttle.clear(key);
    return this.startSession(user, client, { notifyNewDevice: true });
  }

  /**
   * Which lockout counter a sign-in attempt uses. A browser that already signed in to this account
   * (its device cookie matches one of the account's sessions) counts on its own, so strangers'
   * failed guesses cannot lock the owner out of their usual devices.
   */
  private async throttleKey(email: string, user: User | null, client: ClientInfo): Promise<string> {
    const deviceId = validDeviceId(client.deviceId);
    if (!user || !deviceId) return email;
    const known = await this.prisma.session.count({ where: { userId: user.id, deviceId } });
    return known > 0 ? `${email}#${deviceId}` : email;
  }

  private revokeSessionsOp(userId: string) {
    return this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /**
   * What an inbox owner removes when claiming an account someone else registered first: their
   * sessions, their API tokens and their recovery codes (2FA itself is cleared on the user row).
   */
  private evictionOps(userId: string) {
    return [
      this.revokeSessionsOp(userId),
      this.prisma.apiToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      // Links mailed before the claim must not work after it (they could set a password and sign in).
      this.prisma.emailToken.deleteMany({ where: { userId, usedAt: null } }),
    ];
  }

  async me(userId: string): Promise<UserDto> {
    return toUserDto(await this.prisma.user.findUniqueOrThrow({ where: { id: userId } }));
  }

  // ---------- sessions & tokens ----------

  private async startSession(user: User, client: ClientInfo, opts: { notifyNewDevice: boolean }): Promise<IssuedTokens> {
    const deviceId = validDeviceId(client.deviceId) ?? randomUUID();
    if (opts.notifyNewDevice) {
      // Only for accounts that signed in before: the first sign-in is not news to anyone.
      const [known, before] = await Promise.all([
        this.prisma.session.count({ where: { userId: user.id, deviceId } }),
        this.prisma.session.count({ where: { userId: user.id } }),
      ]);
      if (known === 0 && before > 0) await this.mail.sendNewSignInEmail(user, describeUserAgent(client.userAgent), client.ip ?? '');
    }
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        userAgent: client.userAgent?.slice(0, 300),
        ip: client.ip,
        deviceId,
      },
    });
    return { ...(await this.issueTokens(user, session.id)), deviceId };
  }

  private async issueTokens(user: User, sessionId: string): Promise<Omit<IssuedTokens, 'deviceId'>> {
    const accessToken = await this.accessKeys.sign({ sub: user.id, sid: sessionId }, this.accessTtl);
    const jti = randomUUID();
    const refreshToken = await this.refreshKeys.sign(
      { sub: user.id, sid: sessionId, jti } satisfies RefreshPayload,
      Math.floor(this.refreshMaxAgeMs / 1000),
    );
    await this.prisma.refreshToken.create({
      data: {
        id: jti,
        sessionId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshMaxAgeMs),
      },
    });
    return { user: toUserDto(user), accessToken, expiresIn: this.accessTtl, refreshToken };
  }

  /** Rotates the refresh token. Presenting an already-used token revokes the whole session. */
  async refresh(token: string | undefined): Promise<IssuedTokens> {
    if (!token) throw new UnauthorizedException('Missing refresh token');
    const payload = await this.refreshKeys.verify<RefreshPayload>(token);
    if (!payload) throw new UnauthorizedException('Invalid refresh token');

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { session: { include: { user: true } } },
    });
    if (!stored || stored.session.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      // Reuse of a rotated token: assume theft and kill the session.
      await this.revokeSession(stored.sessionId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    await this.prisma.session.update({
      where: { id: stored.sessionId },
      data: { lastUsedAt: new Date() },
    });
    const tokens = await this.issueTokens(stored.session.user, stored.sessionId);
    return { ...tokens, deviceId: stored.session.deviceId ?? undefined };
  }

  async logout(refreshToken: string | undefined, sessionId?: string) {
    let sid = sessionId;
    if (!sid && refreshToken) {
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(refreshToken) },
      });
      sid = stored?.sessionId;
    }
    if (sid) await this.revokeSession(sid);
  }

  private emitRevoked(e: CredentialsRevokedEvent) {
    this.events.emit(AuthEvents.credentialsRevoked, e);
  }

  async revokeSession(sessionId: string) {
    const res = await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.emitRevoked({ credentialId: sessionCredentialId(sessionId) });
    return res;
  }

  async listSessions(userId: string, currentSessionId?: string): Promise<SessionDto[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastUsedAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      current: s.id === currentSessionId,
    }));
  }

  async revokeUserSession(userId: string, sessionId: string) {
    const res = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw new BadRequestException('Session not found');
    this.emitRevoked({ credentialId: sessionCredentialId(sessionId) });
  }

  // ---------- email verification ----------

  /**
   * Verification links must carry the password (and name) they apply: verifying never keeps a
   * password that someone other than the link's recipient may have set.
   */
  private async createEmailToken(
    userId: string,
    type: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
    ttlMs: number,
    pending: { pendingPasswordHash?: string; pendingName?: string; pendingNonceHash?: string } = {},
  ) {
    if (type === 'VERIFY_EMAIL' && !pending.pendingPasswordHash) throw new Error('A verification link needs the password it applies');
    // Only the newest token of each type is valid.
    await this.prisma.emailToken.deleteMany({ where: { userId, type, usedAt: null } });
    const token = randomToken();
    await this.prisma.emailToken.create({
      data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs), ...pending },
    });
    return token;
  }

  private async consumeEmailToken(token: string, type: 'VERIFY_EMAIL' | 'RESET_PASSWORD'): Promise<EmailToken> {
    const row = await this.prisma.emailToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.type !== type || row.usedAt || row.expiresAt < new Date()) {
      throw new BadRequestException('This link is invalid or has expired');
    }
    const claimed = await this.prisma.emailToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) throw new BadRequestException('This link is invalid or has expired');
    return row;
  }

  /** For accounts created before sign-up required verification and still signed in unverified. */
  /**
   * For accounts created before sign-up required verification and still signed in unverified. The
   * caller holds a session for this account, so the link may keep its current password.
   */
  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) throw new BadRequestException('Email is already verified');
    const token = await this.createEmailToken(user.id, 'VERIFY_EMAIL', VERIFY_TTL_MS, { pendingPasswordHash: user.passwordHash });
    await this.mail.sendVerificationEmail(user, token);
  }


  /**
   * Confirms the address and signs in. In the browser that registered (matching nonce cookie) the
   * password chosen there applies. Anywhere else the clicker must choose one (`password`), so only
   * whoever controls the inbox can set it; without one the link is left unused and the caller is
   * told a password is required.
   */
  async verifyEmail(token: string, client: ClientInfo, opts: { nonce?: string; password?: string } = {}): Promise<VerifyResult> {
    const row = await this.prisma.emailToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.type !== 'VERIFY_EMAIL' || row.usedAt || row.expiresAt < new Date()) {
      throw new BadRequestException('This link is invalid or has expired');
    }
    const sameBrowser = !!row.pendingPasswordHash && !!row.pendingNonceHash && !!opts.nonce && sha256(opts.nonce) === row.pendingNonceHash;
    if (!sameBrowser && !opts.password) return { passwordRequired: true };
    const passwordHash = opts.password ? await argon2.hash(opts.password) : row.pendingPasswordHash!;

    // One transaction: the link is spent and the account verified together, and only if it is still
    // unverified. A link must never set a password or open a session (skipping 2FA) on an account
    // that has been verified some other way since it was mailed.
    const user = await this.prisma.$transaction(async (tx) => {
      const spent = await tx.emailToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
      if (spent.count === 0) throw new BadRequestException('This link is invalid or has expired');
      const claimed = await tx.user.updateMany({
        where: { id: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date(), passwordHash, ...(row.pendingName && { name: row.pendingName }), ...NO_TOTP },
      });
      if (claimed.count === 0) {
        // Already verified: the transaction rolls back (the link stays unused) and the link is discarded below.
        throw new BadRequestException('This link is invalid or has expired');
      }
      await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.apiToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.recoveryCode.deleteMany({ where: { userId: row.userId } });
      await tx.emailToken.deleteMany({ where: { userId: row.userId, usedAt: null } });
      return tx.user.findUniqueOrThrow({ where: { id: row.userId } });
    }).catch(async (err: unknown) => {
      // A link for an account that is already verified is useless: drop it.
      if (err instanceof BadRequestException) await this.prisma.emailToken.deleteMany({ where: { id: row.id, usedAt: null, user: { emailVerifiedAt: { not: null } } } });
      throw err;
    });
    this.emitRevoked({ userId: row.userId });
    await this.throttle.clearAll(user.email);
    return this.startSession(user, client, { notifyNewDevice: false });
  }

  // ---------- password ----------

  /** Always resolves, so callers cannot probe which emails are registered. */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;
    // Token and email happen after the response is on its way: an existing account would otherwise
    // take visibly longer to answer than an unknown address.
    void this.createEmailToken(user.id, 'RESET_PASSWORD', RESET_TTL_MS)
      .then((token) => this.mail.sendPasswordResetEmail(user, token))
      .catch((err: Error) => this.logger.error(`Could not send a password reset: ${err.message}`));
  }

  /** Also proves the address and lifts a sign-in lockout. Two-factor stays on. */
  async resetPassword(token: string, password: string) {
    const { userId } = await this.consumeEmailToken(token, 'RESET_PASSWORD');
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // An unverified account is being claimed by the inbox owner: whatever someone set up on it
    // first (sessions, API tokens, 2FA) goes, as with a verification link.
    const wasUnverified = before.emailVerifiedAt === null;
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await argon2.hash(password), ...(wasUnverified && { emailVerifiedAt: new Date(), ...NO_TOTP }) },
      }),
      // A reset means the old password may be compromised: API tokens (which outlive sessions) go too.
      ...(wasUnverified ? this.evictionOps(userId) : [
        this.revokeSessionsOp(userId),
        this.prisma.apiToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
        this.prisma.emailToken.deleteMany({ where: { userId, usedAt: null } }),
      ]),
    ]);
    this.emitRevoked({ userId });
    await this.throttle.clearAll(user.email);
  }

  async changePassword(
    userId: string,
    currentSessionId: string | undefined,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, currentPassword))) {
      throw new BadRequestException('Current password is incorrect');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await argon2.hash(newPassword) },
      }),
      // Sign out every other device.
      this.prisma.session.updateMany({
        where: { userId, revokedAt: null, id: { not: currentSessionId } },
        data: { revokedAt: new Date() },
      }),
      // A reset link mailed earlier must not outlive the password it was meant to replace.
      this.prisma.emailToken.deleteMany({ where: { userId, usedAt: null } }),
    ]);
    this.emitRevoked({ userId, exceptCredentialId: currentSessionId ? sessionCredentialId(currentSessionId) : undefined });
  }
}

/** Clears the authenticator setup on a user row. */
const NO_TOTP = { totpSecret: null, totpEnabledAt: null, totpLastStep: null } as const;

/** The device cookie's value when it looks like one we issued. */
const validDeviceId = (id: string | undefined) => (id && /^[\w-]{10,64}$/.test(id) ? id : undefined);

/** Changes whenever the password or the 2FA setup changes, which ends any 2FA step started before. */
const mfaFingerprint = (u: User) =>
  createHash('sha256').update(`${u.passwordHash}|${u.totpEnabledAt?.toISOString() ?? ''}`).digest('hex').slice(0, 32);

/** Real argon2id hash of a random string, used to equalise login timing for unknown emails. */
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= argon2.hash(randomToken()));
