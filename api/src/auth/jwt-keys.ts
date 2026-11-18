import { createHash } from 'node:crypto';
import type { JwtService } from '@nestjs/jwt';

/** Public identifier of a secret, put in the token header so the right key is found after a rotation. */
export const keyId = (secret: string) => createHash('sha256').update(`jwt-kid:${secret}`).digest('hex').slice(0, 16);

/** Splits a comma-separated list of former secrets (env `*_PREVIOUS`). */
export const previousSecrets = (value: string | undefined) =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Signs with the current secret and verifies with the current or a previous one, so a secret can
 * be rotated without signing everyone out: move the old value to `*_PREVIOUS`, set a new one, and
 * drop the old one once tokens signed with it have expired.
 */
export class JwtKeyRing {
  private readonly current: { kid: string; secret: string };
  private readonly byKid: Map<string, string>;

  constructor(
    private readonly jwt: JwtService,
    current: string,
    previous: readonly string[] = [],
  ) {
    this.current = { kid: keyId(current), secret: current };
    this.byKid = new Map([current, ...previous].map((s) => [keyId(s), s]));
  }

  sign(payload: object, expiresInSeconds: number): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.current.secret, expiresIn: expiresInSeconds, algorithm: 'HS256', keyid: this.current.kid,
    });
  }

  /** The verified payload, or null for a bad, expired or unknown-key token. */
  async verify<T extends object>(token: string): Promise<T | null> {
    const header = (this.jwt.decode(token, { complete: true }) as { header?: { kid?: unknown } } | null)?.header;
    // Tokens issued before key ids existed have none: they can only have come from the current secret.
    const secret = header?.kid === undefined ? this.current.secret : this.byKid.get(String(header.kid));
    if (!secret) return null;
    return this.jwt.verifyAsync<T>(token, { secret, algorithms: ['HS256'] }).catch(() => null);
  }
}
