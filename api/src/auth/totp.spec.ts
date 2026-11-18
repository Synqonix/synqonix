import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUrl, timeStep, verifyTotp } from './totp.js';

// RFC 6238 appendix B: SHA-1 key "12345678901234567890", 8 digits.
const RFC_KEY = Buffer.from('12345678901234567890');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    for (const [t, code] of RFC_VECTORS) expect(hotp(RFC_KEY, Math.floor(t / 30), 8), String(t)).toBe(code);
  });

  it('round-trips base32 like authenticator apps (RFC 4648)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(base32Decode(newTotpSecret())).toHaveLength(20);
  });

  it('accepts the current code and one step of drift, and reports its step', () => {
    const secret = base32Encode(RFC_KEY);
    const now = 1111111111 * 1000;
    const code = hotp(RFC_KEY, timeStep(now));
    expect(verifyTotp(secret, code, now)).toBe(timeStep(now));
    expect(verifyTotp(secret, code, now + 30_000)).toBe(timeStep(now));
    expect(verifyTotp(secret, code, now + 90_000)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('builds an otpauth link and distinct recovery codes', () => {
    expect(otpauthUrl('ABC', 'ada@example.com')).toBe('otpauth://totp/Synqonix%3Aada%40example.com?secret=ABC&issuer=Synqonix&algorithm=SHA1&digits=6&period=30');
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(normalizeRecoveryCode(' K7QM-2X9D ')).toBe('k7qm2x9d');
  });
});
