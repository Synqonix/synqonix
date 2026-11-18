import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Derives a 256-bit key per purpose, so one ENCRYPTION_KEY never encrypts two kinds of data with the same key. */
const deriveKey = (purpose: string, secret: string) => createHash('sha256').update(`${purpose}:${secret}`).digest();

/**
 * AES-256-GCM encryption for secrets stored in the database (webhook signing secrets, later
 * bring-your-own API keys), so a leaked database does not leak them. Stored as
 * `iv.tag.ciphertext` in base64url.
 *
 * Encrypts with the first key; decrypts with whichever key fits (GCM authenticates, so a wrong key
 * is detected), which is how keys are rotated: put the old one in ENCRYPTION_KEY_PREVIOUS.
 */
export class SecretBox {
  private readonly keys: Buffer[];

  constructor(purpose: string, secrets: readonly string[]) {
    const unique = [...new Set(secrets.filter(Boolean))];
    if (unique.length === 0) throw new Error('SecretBox needs at least one key');
    this.keys = unique.map((s) => deriveKey(purpose, s));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[0], iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(stored: string): string {
    const parts = stored.split('.');
    if (parts.length !== 3) throw new Error('Malformed encrypted value');
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
    for (const key of this.keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        // wrong key: try the next one
      }
    }
    throw new Error('Cannot decrypt value with any configured key');
  }
}

/**
 * The keys a SecretBox uses, newest first: ENCRYPTION_KEY, then ENCRYPTION_KEY_PREVIOUS (rotation),
 * then `legacy` for values written before ENCRYPTION_KEY existed.
 */
export function encryptionSecrets(env: { ENCRYPTION_KEY: string; ENCRYPTION_KEY_PREVIOUS?: string }, ...legacy: string[]): string[] {
  const previous = (env.ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [env.ENCRYPTION_KEY, ...previous, ...legacy];
}
