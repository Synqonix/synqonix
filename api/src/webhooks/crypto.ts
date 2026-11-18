import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** `X-Synqonix-Signature` value: HMAC-SHA256 over `<timestamp>.<body>`, so a captured request cannot be replayed with a new time. */
export const signPayload = (secret: string, timestamp: number, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export function verifySignature(secret: string, timestamp: number, body: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
