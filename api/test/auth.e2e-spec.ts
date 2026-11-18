import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { base32Decode, hotp, timeStep } from '../src/auth/totp.js';
import { sha256 } from '../src/common/crypto.js';
import { createTestApp, type FakeMailService, resetDatabase, signUp } from './helpers.js';

const creds = { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' };

describe('Auth (e2e)', () => {
  let app: NestExpressApplication;
  let mail: FakeMailService;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => ({ app, mail, prisma } = await createTestApp()));
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDatabase(prisma);
    mail.sent = [];
  });

  const startRegistration = (body: Record<string, unknown> = creds) => http().post('/api/v1/auth/register').send(body);
  /** Opens the newest emailed link without the registration cookie (another device), setting `password`. */
  const verifyLink = (email = creds.email, password: string | null = creds.password) =>
    http().post('/api/v1/auth/verify-email').send({ token: mail.tokenFor(email, 'verify-email'), ...(password !== null && { password }) });
  /** Registers and follows the emailed link, which signs in: the response carries the tokens. */
  const register = async () => {
    await startRegistration().expect(201);
    return verifyLink().expect(200);
  };
  /** Asks for a reset link. The link is made after the response (so timing does not reveal the account): wait for it. */
  const forgot = async (email = creds.email) => {
    await http().post('/api/v1/auth/forgot-password').send({ email }).expect(204);
    const end = Date.now() + 3000;
    while (!mail.tokenFor(email, 'reset-password') && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  };
  const login = (password = creds.password, email = creds.email) => http().post('/api/v1/auth/login').send({ email, password });

  it('registers without signing in; in the same browser the emailed link applies the password and signs in', async () => {
    const browser = request.agent(app.getHttpServer());
    const res = await browser.post('/api/v1/auth/register').send(creds).expect(201);
    expect(res.body).toEqual({ verificationSent: true });
    const regCookies = res.headers['set-cookie'] as unknown as string[];
    expect(regCookies.find((c) => c.startsWith('sx_registration='))).toMatch(/HttpOnly/);
    expect(regCookies.find((c) => c.startsWith('sx_refresh='))).toBeUndefined();

    const verified = await browser.post('/api/v1/auth/verify-email').send({ token: mail.tokenFor(creds.email, 'verify-email') }).expect(200);
    expect(verified.body.user).toMatchObject({ email: creds.email, emailVerified: true, twoFactorEnabled: false });
    expect(verified.body.user.passwordHash).toBeUndefined();
    const cookies = verified.headers['set-cookie'] as unknown as string[];
    expect(cookies.find((c) => c.startsWith('sx_refresh='))).toMatch(/HttpOnly/);
    expect(cookies.find((c) => c.startsWith('sx_device='))).toMatch(/HttpOnly/);
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${verified.body.accessToken}`).expect(200);
    expect(mail.bySubject(creds.email, 'new-sign-in')).toEqual([]); // first sign-in is not news
    await browser.post('/api/v1/auth/login').send({ email: creds.email, password: creds.password }).expect(200); // the password applied
  });

  it('asks for a password when the link is opened elsewhere, and leaves the link unused until then', async () => {
    await startRegistration().expect(201);
    expect((await verifyLink(creds.email, null).expect(200)).body).toEqual({ passwordRequired: true });
    await verifyLink(creds.email, 'short').expect(400);
    const done = await verifyLink(creds.email, 'chosen on my phone 1').expect(200);
    expect(done.body.accessToken).toBeTruthy();
    await login('chosen on my phone 1').expect(200);
    await login().expect(401); // the password typed at registration never applied
  });

  it('answers an existing email exactly like a new one and emails the owner instead', async () => {
    await register();
    const again = await startRegistration({ ...creds, password: 'an attacker password' }).expect(201);
    const fresh = await startRegistration({ ...creds, email: 'new@example.com' }).expect(201);
    expect(again.body).toEqual(fresh.body);
    const cookieName = (r: { headers: Record<string, unknown> }) => ((r.headers['set-cookie'] as string[]) ?? []).map((c) => c.split('=')[0]);
    expect(cookieName(again)).toEqual(cookieName(fresh)); // same cookies too
    expect(mail.bySubject(creds.email, 'account-exists')).toHaveLength(1);
    await login('an attacker password').expect(401); // nothing changed
    await http().post('/api/v1/auth/register').send({ ...creds, email: 'b@example.com', password: 'short' }).expect(400);
  });

  it('never lets whoever registered an address first choose its password', async () => {
    const attacker = request.agent(app.getHttpServer());
    const victim = request.agent(app.getHttpServer());
    await attacker.post('/api/v1/auth/register').send({ ...creds, password: 'attacker chosen 1' }).expect(201);
    await victim.post('/api/v1/auth/register').send({ ...creds, password: 'my own password 1' }).expect(201);
    // The attacker registers again, so the newest link in the victim's inbox is theirs.
    await attacker.post('/api/v1/auth/register').send({ ...creds, password: 'attacker chosen 2' }).expect(201);
    // Signing in to the unverified account does not touch the victim's links.
    const sent = mail.sent.length;
    expect((await attacker.post('/api/v1/auth/login').send({ email: creds.email, password: 'attacker chosen 1' }).expect(403)).body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(mail.sent).toHaveLength(sent);

    // The victim opens that newest link in their own browser: no cookie of theirs matches, so they choose the password.
    const token = mail.tokenFor(creds.email, 'verify-email');
    expect((await victim.post('/api/v1/auth/verify-email').send({ token }).expect(200)).body).toEqual({ passwordRequired: true });
    await victim.post('/api/v1/auth/verify-email').send({ token, password: 'my own password 1' }).expect(200);
    await login('my own password 1').expect(200);
    for (const p of ['attacker chosen 1', 'attacker chosen 2']) await login(p).expect(401);
  });

  it('refuses sign-in before verification without sending anything', async () => {
    await startRegistration().expect(201);
    const sentBefore = mail.sent.length;
    await login('wrong wrong wrong').expect(401);
    const res = await login().expect(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(mail.sent).toHaveLength(sentBefore);
    await verifyLink().expect(200);
    await login().expect(200);
  });

  it('signs in at once when registering through an invitation link', async () => {
    const owner = await signUp(app, 'Owner');
    const ws = (await http().post('/api/v1/workspaces').set(owner.auth).send({ name: 'Acme' }).expect(201)).body.id;
    await http().post(`/api/v1/workspaces/${ws}/invitations`).set(owner.auth).send({ email: creds.email, role: 'MEMBER' }).expect(201);
    const invitationToken = mail.inviteTokenFor(creds.email)!;

    // An invitation for another address proves nothing about this one.
    expect((await startRegistration({ ...creds, email: 'other@example.com', invitationToken }).expect(201)).body).toEqual({ verificationSent: true });

    const res = await startRegistration({ ...creds, invitationToken }).expect(201);
    expect(res.body.user).toMatchObject({ email: creds.email, emailVerified: true });
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };
    await http().post(`/api/v1/invitations/${invitationToken}/accept`).set(auth).expect(201);
  });

  it("does not let strangers' failed guesses lock the owner out of a device they signed in with before", async () => {
    await register();
    const laptop = request.agent(app.getHttpServer());
    await laptop.post('/api/v1/auth/login').send({ email: creds.email, password: creds.password }).expect(200); // device cookie now known
    for (let i = 0; i < 10; i++) await login('attacker guess 123').expect(401);
    await login().expect(429); // unknown devices are locked out...
    await laptop.post('/api/v1/auth/login').send({ email: creds.email, password: creds.password }).expect(200); // ...the owner's laptop is not
    // A known device still has its own counter.
    for (let i = 0; i < 10; i++) await laptop.post('/api/v1/auth/login').send({ email: creds.email, password: 'typo typo typo' }).expect(401);
    await laptop.post('/api/v1/auth/login').send({ email: creds.email, password: creds.password }).expect(429);
  });

  it('locks sign-in for an email after repeated failures, even for unknown emails, until a password reset', async () => {
    await register();
    for (let i = 0; i < 10; i++) await login('wrong wrong wrong').expect(401);
    const locked = await login().expect(429);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');

    for (let i = 0; i < 10; i++) await login('whatever', 'ghost@example.com').expect(401);
    await login('whatever', 'ghost@example.com').expect(429); // same answer: no hint that the account does not exist

    await forgot();
    await http().post('/api/v1/auth/reset-password').send({ token: mail.tokenFor(creds.email, 'reset-password'), password: 'a brand new password' }).expect(204);
    await login('a brand new password').expect(200);
  });

  it('emails the owner when an account signs in from a new device', async () => {
    await register();
    const browser = request.agent(app.getHttpServer());
    await browser.post('/api/v1/auth/login').send({ email: creds.email, password: creds.password }).expect(200);
    expect(mail.bySubject(creds.email, 'new-sign-in')).toHaveLength(1);
    await browser.post('/api/v1/auth/login').send({ email: creds.email, password: creds.password }).expect(200);
    expect(mail.bySubject(creds.email, 'new-sign-in')).toHaveLength(1); // same device cookie: known
  });

  describe('claiming an address someone else registered first', () => {
    /** An unverified account with everything a squatter could have set up (as before sign-up needed verification). */
    async function squat() {
      const user = await prisma.user.create({ data: { email: creds.email, name: 'Squatter', passwordHash: 'x', totpSecret: 'enc', totpEnabledAt: new Date() } });
      const session = await prisma.session.create({ data: { userId: user.id } });
      const token = `sqx_${'a'.repeat(40)}`;
      await prisma.apiToken.create({ data: { userId: user.id, name: 'squat', tokenHash: sha256(token), prefix: token.slice(0, 12) } });
      await prisma.recoveryCode.create({ data: { userId: user.id, codeHash: 'h' } });
      const secret = app.get(ConfigService).get<string>('JWT_ACCESS_SECRET');
      const access = await app.get(JwtService).signAsync({ sub: user.id, sid: session.id }, { secret, expiresIn: 60 });
      // Both credentials work while squatting (so the rejections below mean something).
      await http().get('/api/v1/users/me').set('Authorization', `Bearer ${token}`).expect(200);
      await http().get('/api/v1/users/me').set('Authorization', `Bearer ${access}`).expect(200);
      return { user, token, access };
    }
    const expectEvicted = async ({ user, token, access }: Awaited<ReturnType<typeof squat>>) => {
      await http().get('/api/v1/users/me').set('Authorization', `Bearer ${token}`).expect(401);
      await http().get('/api/v1/users/me').set('Authorization', `Bearer ${access}`).expect(401);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row).toMatchObject({ totpSecret: null, totpEnabledAt: null, totpLastStep: null });
      expect(row.emailVerifiedAt).not.toBeNull();
      expect(await prisma.recoveryCode.count({ where: { userId: user.id } })).toBe(0);
    };

    it('through the verification link', async () => {
      const squatted = await squat();
      await startRegistration().expect(201);
      await verifyLink().expect(200);
      await expectEvicted(squatted);
    });

    it('through a password reset', async () => {
      const squatted = await squat();
      await forgot();
      await http().post('/api/v1/auth/reset-password').send({ token: mail.tokenFor(creds.email, 'reset-password'), password: 'a brand new password' }).expect(204);
      await expectEvicted(squatted);
    });

    it('through an invitation link', async () => {
      const squatted = await squat();
      const owner = await signUp(app, 'Owner');
      const ws = (await http().post('/api/v1/workspaces').set(owner.auth).send({ name: 'Acme' }).expect(201)).body.id;
      await http().post(`/api/v1/workspaces/${ws}/invitations`).set(owner.auth).send({ email: creds.email, role: 'MEMBER' }).expect(201);
      await startRegistration({ ...creds, invitationToken: mail.inviteTokenFor(creds.email) }).expect(201);
      await expectEvicted(squatted);
    });

    it('is not possible to prepare from an unverified account: no API tokens, no 2FA setup', async () => {
      const { access } = await squat();
      const auth = { Authorization: `Bearer ${access}` };
      // (this session predates verify-first sign-up; the new code never issues one)
      await http().post('/api/v1/api-tokens').set(auth).send({ name: 'more' }).expect(403);
      await http().post('/api/v1/auth/2fa/setup').set(auth).expect(403);
    });
  });

  describe('two-factor authentication', () => {
    const code = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep() + offset);

    async function enable() {
      const { body } = await register();
      const auth = { Authorization: `Bearer ${body.accessToken}` };
      const setup = await http().post('/api/v1/auth/2fa/setup').set(auth).expect(200);
      expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Synqonix/);
      await http().post('/api/v1/auth/2fa/enable').set(auth).send({ code: '000000' }).expect(400);
      const enabled = await http().post('/api/v1/auth/2fa/enable').set(auth).send({ code: code(setup.body.secret) }).expect(200);
      expect(enabled.body.recoveryCodes).toHaveLength(10);
      return { auth, secret: setup.body.secret as string, recoveryCodes: enabled.body.recoveryCodes as string[] };
    }

    it('asks for a code after the password and accepts each code only once', async () => {
      const { auth, secret } = await enable();
      expect((await http().get('/api/v1/users/me').set(auth).expect(200)).body.twoFactorEnabled).toBe(true);

      const first = await login().expect(200);
      expect(first.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
      expect(first.body.accessToken).toBeUndefined();
      // The step token is no access token.
      await http().get('/api/v1/users/me').set('Authorization', `Bearer ${first.body.mfaToken}`).expect(401);

      await http().post('/api/v1/auth/login/2fa').send({ mfaToken: first.body.mfaToken, code: '123456' }).expect(401);
      const next = code(secret, 1); // the setup used the current step; the next one is fresh
      const done = await http().post('/api/v1/auth/login/2fa').send({ mfaToken: first.body.mfaToken, code: next }).expect(200);
      await http().get('/api/v1/users/me').set('Authorization', `Bearer ${done.body.accessToken}`).expect(200);

      const second = await login().expect(200);
      await http().post('/api/v1/auth/login/2fa').send({ mfaToken: second.body.mfaToken, code: next }).expect(401); // replay
    });

    it('accepts each recovery code once and can turn 2FA off with password and code', async () => {
      const { auth, recoveryCodes } = await enable();
      const step = await login().expect(200);
      await http().post('/api/v1/auth/login/2fa').send({ mfaToken: step.body.mfaToken, code: recoveryCodes[0].toUpperCase() }).expect(200);
      await http().post('/api/v1/auth/login/2fa').send({ mfaToken: step.body.mfaToken, code: recoveryCodes[0] }).expect(401);
      expect((await http().get('/api/v1/auth/2fa').set(auth).expect(200)).body).toEqual({ enabled: true, recoveryCodesLeft: 9 });

      await http().post('/api/v1/auth/2fa/disable').set(auth).send({ password: 'wrong', code: recoveryCodes[1] }).expect(400);
      await http().post('/api/v1/auth/2fa/disable').set(auth).send({ password: creds.password, code: recoveryCodes[1] }).expect(204);
      const plain = await login().expect(200);
      expect(plain.body.accessToken).toBeTruthy();
    });

    it('ends a started 2FA sign-in when the password is reset', async () => {
      const { secret } = await enable();
      const step = await login().expect(200);
      await forgot();
      await http().post('/api/v1/auth/reset-password').send({ token: mail.tokenFor(creds.email, 'reset-password'), password: 'a brand new password' }).expect(204);
      await http().post('/api/v1/auth/login/2fa').send({ mfaToken: step.body.mfaToken, code: code(secret, 1) }).expect(401);
    });

    it('counts wrong codes towards the lockout', async () => {
      await enable();
      const step = await login().expect(200);
      for (let i = 0; i < 10; i++) await http().post('/api/v1/auth/login/2fa').send({ mfaToken: step.body.mfaToken, code: '999999' }).expect(401);
      await http().post('/api/v1/auth/login/2fa').send({ mfaToken: step.body.mfaToken, code: '999999' }).expect(429);
      await login().expect(429);
    });

    it('keeps 2FA management away from API tokens', async () => {
      const { body } = await register();
      const auth = { Authorization: `Bearer ${body.accessToken}` };
      const t = (await http().post('/api/v1/api-tokens').set(auth).send({ name: 'ci' }).expect(201)).body.token;
      await http().post('/api/v1/auth/2fa/setup').set('Authorization', `Bearer ${t}`).expect(403);
    });
  });

  it('logs in case-insensitively and rejects bad credentials', async () => {
    await register();
    await http().post('/api/v1/auth/login').send({ email: 'ADA@example.com', password: creds.password }).expect(200);
    await http().post('/api/v1/auth/login').send({ email: creds.email, password: 'nope-nope-nope' }).expect(401);
    await http().post('/api/v1/auth/login').send({ email: 'ghost@example.com', password: 'nope-nope-nope' }).expect(401);
  });

  it('protects routes and serves /users/me with a valid token', async () => {
    await http().get('/api/v1/users/me').expect(401);
    const { body } = await register();
    const me = await http().get('/api/v1/users/me').set('Authorization', `Bearer ${body.accessToken}`).expect(200);
    expect(me.body.email).toBe(creds.email);
    await http().get('/api/v1/users/me').set('Authorization', 'Bearer garbage').expect(401);
  });

  it('accepts each verification link once', async () => {
    const { body } = await register();
    await verifyLink().expect(400);
    const me = await http().get('/api/v1/users/me').set('Authorization', `Bearer ${body.accessToken}`);
    expect(me.body.emailVerified).toBe(true);
    await http().post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${body.accessToken}`).expect(400);
  });

  it('rotates refresh tokens and revokes the session on reuse', async () => {
    const { body } = await register();
    const first = body.refreshToken as string;
    const rotated = await http().post('/api/v1/auth/refresh').send({ refreshToken: first }).expect(200);
    expect(rotated.body.refreshToken).not.toBe(first);

    // Reusing the old token is treated as theft: the whole session dies.
    await http().post('/api/v1/auth/refresh').send({ refreshToken: first }).expect(401);
    await http().post('/api/v1/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${rotated.body.accessToken}`).expect(401);
  });

  it('refreshes using the httpOnly cookie and logs out', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/v1/auth/register').send(creds).expect(201);
    await agent.post('/api/v1/auth/verify-email').send({ token: mail.tokenFor(creds.email, 'verify-email') }).expect(200);
    const refreshed = await agent.post('/api/v1/auth/refresh').send({}).expect(200);
    await agent.post('/api/v1/auth/logout').send({}).expect(204);
    await agent.post('/api/v1/auth/refresh').send({}).expect(401);
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${refreshed.body.accessToken}`).expect(401);
  });

  it('never shows the refresh token to browser scripts, only the httpOnly cookie', async () => {
    const browser = request.agent(app.getHttpServer());
    const origin = 'http://localhost:3000';
    await browser.post('/api/v1/auth/register').set('Origin', origin).send(creds).expect(201);
    const reg = await browser.post('/api/v1/auth/verify-email').set('Origin', origin).send({ token: mail.tokenFor(creds.email, 'verify-email') }).expect(200);
    expect(reg.body.accessToken).toBeTruthy();
    expect(reg.body.refreshToken).toBeUndefined();
    expect((reg.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sx_refresh='))).toMatch(/HttpOnly/);

    const login = await browser.post('/api/v1/auth/login').set('Origin', origin).send({ email: creds.email, password: creds.password }).expect(200);
    expect(login.body.refreshToken).toBeUndefined();
    const refreshed = await browser.post('/api/v1/auth/refresh').set('Origin', origin).send({}).expect(200);
    expect(refreshed.body.refreshToken).toBeUndefined();
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${refreshed.body.accessToken}`).expect(200);
  });

  it('moves a session whose refresh token was stored by an older web app into the cookie', async () => {
    const { body } = await register(); // non-browser: the token comes back in the body
    const browser = request.agent(app.getHttpServer());
    const moved = await browser.post('/api/v1/auth/refresh').set('Origin', 'http://localhost:3000').send({ refreshToken: body.refreshToken }).expect(200);
    expect(moved.body.refreshToken).toBeUndefined();
    await browser.post('/api/v1/auth/refresh').set('Origin', 'http://localhost:3000').send({}).expect(200);
  });

  it('resets a password, invalidating sessions and the link', async () => {
    const { body } = await register();
    await http().post('/api/v1/auth/forgot-password').send({ email: 'ghost@example.com' }).expect(204);
    await new Promise((r) => setTimeout(r, 300));
    expect(mail.tokenFor('ghost@example.com', 'reset-password')).toBeUndefined();

    await forgot();
    const token = mail.tokenFor(creds.email, 'reset-password')!;
    await http().post('/api/v1/auth/reset-password').send({ token, password: 'a brand new password' }).expect(204);
    await http().post('/api/v1/auth/reset-password').send({ token, password: 'another new password' }).expect(400);

    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${body.accessToken}`).expect(401);
    await http().post('/api/v1/auth/login').send({ email: creds.email, password: creds.password }).expect(401);
    await http().post('/api/v1/auth/login').send({ email: creds.email, password: 'a brand new password' }).expect(200);
  });

  it('does not let a verification link mailed before an account was claimed set a password or sign in', async () => {
    await startRegistration().expect(201);
    const oldLink = mail.tokenFor(creds.email, 'verify-email')!;
    // The address's owner claims the account through a password reset instead.
    await forgot();
    await http().post('/api/v1/auth/reset-password').send({ token: mail.tokenFor(creds.email, 'reset-password'), password: 'the owners password' }).expect(204);
    const replay = await http().post('/api/v1/auth/verify-email').send({ token: oldLink, password: 'attacker chosen password' });
    expect(replay.status).toBe(400);
    expect(replay.body.accessToken).toBeUndefined();
    await login('attacker chosen password').expect(401);
    await login('the owners password').expect(200);
  });

  it('does not accept a verification link for an account that is already verified', async () => {
    await startRegistration().expect(201);
    const link = mail.tokenFor(creds.email, 'verify-email')!;
    await prisma.user.update({ where: { email: creds.email }, data: { emailVerifiedAt: new Date() } });
    await http().post('/api/v1/auth/verify-email').send({ token: link, password: 'attacker chosen password' }).expect(400);
    await login('attacker chosen password').expect(401);
  });

  it('revokes API tokens when the password is reset', async () => {
    const { body } = await register();
    const token = (await http().post('/api/v1/api-tokens').set('Authorization', `Bearer ${body.accessToken}`).send({ name: 'ci' }).expect(201)).body.token as string;
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${token}`).expect(200);
    await forgot();
    await http().post('/api/v1/auth/reset-password').send({ token: mail.tokenFor(creds.email, 'reset-password'), password: 'a brand new password' }).expect(204);
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('ends outstanding reset links when the password is changed', async () => {
    const a = await register();
    await forgot();
    const link = mail.tokenFor(creds.email, 'reset-password')!;
    await http().post('/api/v1/auth/change-password').set('Authorization', `Bearer ${a.body.accessToken}`)
      .send({ currentPassword: creds.password, newPassword: 'a changed password' }).expect(204);
    await http().post('/api/v1/auth/reset-password').send({ token: link, password: 'attacker password' }).expect(400);
  });

  it('changes password and signs out other sessions only', async () => {
    const a = await register();
    const b = await http().post('/api/v1/auth/login').send({ email: creds.email, password: creds.password });
    await http().post('/api/v1/auth/change-password').set('Authorization', `Bearer ${a.body.accessToken}`)
      .send({ currentPassword: 'wrong-wrong', newPassword: 'new password 123' }).expect(400);
    await http().post('/api/v1/auth/change-password').set('Authorization', `Bearer ${a.body.accessToken}`)
      .send({ currentPassword: creds.password, newPassword: 'new password 123' }).expect(204);
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${a.body.accessToken}`).expect(200);
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${b.body.accessToken}`).expect(401);
  });

  it('lists and revokes sessions', async () => {
    const a = await register();
    const b = await http().post('/api/v1/auth/login').send({ email: creds.email, password: creds.password });
    const list = await http().get('/api/v1/auth/sessions').set('Authorization', `Bearer ${a.body.accessToken}`).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    await http().delete(`/api/v1/auth/sessions/${other.id}`).set('Authorization', `Bearer ${a.body.accessToken}`).expect(204);
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${b.body.accessToken}`).expect(401);
  });

  it('issues API tokens that authenticate but cannot manage credentials', async () => {
    const { body } = await register();
    const auth = { Authorization: `Bearer ${body.accessToken}` };
    const created = await http().post('/api/v1/api-tokens').set(auth).send({ name: 'vscode' }).expect(201);
    expect(created.body.token).toMatch(/^sqx_/);

    const viaToken = { Authorization: `Bearer ${created.body.token}` };
    await http().get('/api/v1/users/me').set(viaToken).expect(200);
    await http().post('/api/v1/api-tokens').set(viaToken).send({ name: 'x' }).expect(403);
    await http().get('/api/v1/auth/sessions').set(viaToken).expect(403);

    const list = await http().get('/api/v1/api-tokens').set(auth).expect(200);
    expect(list.body[0]).not.toHaveProperty('token');
    expect(list.body[0].prefix).toBe(created.body.token.slice(0, 12));

    await http().delete(`/api/v1/api-tokens/${created.body.id}`).set(auth).expect(204);
    await http().get('/api/v1/users/me').set(viaToken).expect(401);
  });

  it('limits API tokens to their scopes and workspace', async () => {
    const { body } = await register();
    const auth = { Authorization: `Bearer ${body.accessToken}` };
    const mine = (await http().post('/api/v1/workspaces').set(auth).send({ name: 'Mine' }).expect(201)).body.id;
    const other = (await http().post('/api/v1/workspaces').set(auth).send({ name: 'Other' }).expect(201)).body.id;
    const stranger = await signUp(app, 'Stranger');
    const theirs = (await http().post('/api/v1/workspaces').set(stranger.auth).send({ name: 'Theirs' }).expect(201)).body.id;
    await http().post('/api/v1/api-tokens').set(auth).send({ name: 'x', workspaceId: theirs }).expect(400);

    const ro = (await http().post('/api/v1/api-tokens').set(auth).send({ name: 'ro', scopes: ['read'] }).expect(201)).body;
    expect(ro.scopes).toEqual(['read']);
    const roAuth = { Authorization: `Bearer ${ro.token}` };
    await http().get(`/api/v1/workspaces/${mine}/projects`).set(roAuth).expect(200);
    await http().post(`/api/v1/workspaces/${mine}/projects`).set(roAuth).send({ name: 'P', key: 'PP' }).expect(403);

    const bound = (await http().post('/api/v1/api-tokens').set(auth).send({ name: 'bound', workspaceId: mine }).expect(201)).body;
    expect(bound).toMatchObject({ scopes: ['read', 'write'], workspaceId: mine });
    const bAuth = { Authorization: `Bearer ${bound.token}` };
    await http().post(`/api/v1/workspaces/${mine}/projects`).set(bAuth).send({ name: 'P', key: 'PP' }).expect(201);
    await http().get(`/api/v1/workspaces/${other}/projects`).set(bAuth).expect(403);
    expect((await http().get('/api/v1/workspaces').set(bAuth).expect(200)).body.map((w: { id: string }) => w.id)).toEqual([mine]);
    await http().get('/api/v1/users/me').set(bAuth).expect(200);
    // The inbox works, limited to the token's workspace; preferences (every workspace) cannot be changed.
    await prisma.notification.createMany({ data: [
      { userId: body.user.id, workspaceId: mine, type: 'ASSIGNED', title: 'in mine', url: '/' },
      { userId: body.user.id, workspaceId: other, type: 'ASSIGNED', title: 'in other', url: '/' },
    ] });
    const inbox = (await http().get('/api/v1/notifications').set(bAuth).expect(200)).body.items as { title: string; id: string }[];
    expect(inbox.map((n) => n.title)).toEqual(['in mine']);
    expect((await http().get('/api/v1/notifications/unread-count').set(bAuth).expect(200)).body.count).toBe(1);
    const elsewhere = (await prisma.notification.findFirst({ where: { workspaceId: other } }))!;
    await http().post(`/api/v1/notifications/${elsewhere.id}/read`).set(bAuth).expect(404);
    await http().put('/api/v1/notifications/preferences').set(bAuth).send({}).expect(403);

    // Tokens from before scopes existed keep full access (the column defaults to both).
    const legacy = (await http().post('/api/v1/api-tokens').set(auth).send({ name: 'legacy' }).expect(201)).body;
    expect(legacy).toMatchObject({ scopes: ['read', 'write'], workspaceId: null });
  });

  it('deletes the account with the right password', async () => {
    const { body } = await register();
    const auth = { Authorization: `Bearer ${body.accessToken}` };
    await http().delete('/api/v1/users/me').set(auth).send({ password: 'wrong' }).expect(401);
    await http().delete('/api/v1/users/me').set(auth).send({ password: creds.password }).expect(204);
    await http().post('/api/v1/auth/login').send({ email: creds.email, password: creds.password }).expect(401);
  });
});
