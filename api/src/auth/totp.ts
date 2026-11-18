import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 s), as authenticator apps expect. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits, base32) for an authenticator app. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const timeStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** HOTP (RFC 4226) value for one counter. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * The time step a code belongs to (accepting one step of clock drift either way), or null.
 * Callers reject steps at or before the last one used, so a code cannot be replayed.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = timeStep(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** otpauth:// link for the QR code an authenticator app scans. */
export const otpauthUrl = (secretBase32: string, account: string, issuer = 'Synqonix') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

/** Ten single-use recovery codes like `k7qm-2x9d` (40 bits each). */
export function newRecoveryCodes(count = 10): string[] {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: count }, () => {
    const b = randomBytes(8);
    const s = Array.from(b, (x) => chars[x % chars.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
}

/** Recovery codes are compared case- and dash-insensitively. */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
