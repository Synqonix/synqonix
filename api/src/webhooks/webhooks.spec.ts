import { describe, expect, it } from 'vitest';
import { newSecret, signPayload, verifySignature } from './crypto.js';
import { encryptionSecrets, SecretBox } from '../common/secret-box.js';
import { checkWebhookUrl, isPrivateAddress } from './url-guard.js';

describe('private addresses', () => {
  it('flags everything a webhook must not reach', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('sees through IPv4 addresses embedded in IPv6, in any notation', () => {
    for (const ip of [
      '::ffff:7f00:1', '::FFFF:7F00:0001', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:a9fe:a9fe', // mapped, hex form (what URL() produces)
      '::127.0.0.1', '::a00:1', // IPv4-compatible
      '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b:1::1', // NAT64
      '2002:7f00:1::', '2002:a9fe:a9fe::1', // 6to4
      '2001:0:4136:e378::1', '2001:db8::1', '100::1', 'ff02::1', 'fe80::1%eth0', '::', 'febf::1',
      '1::2::3', '12345::1', '1:2:3:4:5:6:7', // malformed: refuse
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['::ffff:808:808', '64:ff9b::8.8.8.8', '2002:808:808::1', '2001:4860:4860::8888', '2a00:1450::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('webhook URL check', () => {
  it('accepts public https URLs', () => {
    expect(checkWebhookUrl('https://hooks.example.com/path?x=1', false).ok).toBe(true);
    expect(checkWebhookUrl('https://8.8.8.8/hook', false).ok).toBe(true);
  });
  it('rejects the rest', () => {
    for (const bad of ['https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x', 'https://[64:ff9b::a9fe:a9fe]/x', 'http://hooks.example.com', 'ftp://x.example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://intranet/x', 'https://svc.internal/x', 'https://printer.local/x', 'https://user:pw@example.com/x', 'nonsense', `https://example.com/${'a'.repeat(2100)}`]) {
      expect(checkWebhookUrl(bad, false).ok, bad).toBe(false);
    }
  });
  it('lets local development target anything, including http', () => {
    expect(checkWebhookUrl('http://localhost:9000/hook', true).ok).toBe(true);
    expect(checkWebhookUrl('http://user:pw@localhost/x', true).ok).toBe(false);
  });
});

describe('secrets and signatures', () => {
  it('round-trips encrypted secrets and never repeats a ciphertext', () => {
    const secret = newSecret();
    expect(secret).toMatch(/^whsec_/);
    const box = new SecretBox('webhook-secrets', ['app-key']);
    const a = box.encrypt(secret);
    expect(a).not.toContain(secret);
    expect(box.decrypt(a)).toBe(secret);
    expect(box.encrypt(secret)).not.toBe(a);
    expect(() => new SecretBox('webhook-secrets', ['other-key']).decrypt(a)).toThrow();
    expect(() => new SecretBox('other-purpose', ['app-key']).decrypt(a)).toThrow();
    expect(() => box.decrypt(`${a.slice(0, -2)}xx`)).toThrow();
  });
  it('reads values written with a previous or legacy key and writes with the current one', () => {
    const legacy = new SecretBox('webhook-secrets', ['jwt-refresh-secret']).encrypt('old');
    const rotated = new SecretBox('webhook-secrets', ['key-v1']).encrypt('rotated');
    const box = new SecretBox('webhook-secrets', encryptionSecrets({ ENCRYPTION_KEY: 'key-v2', ENCRYPTION_KEY_PREVIOUS: 'key-v1' }, 'jwt-refresh-secret'));
    expect(box.decrypt(legacy)).toBe('old');
    expect(box.decrypt(rotated)).toBe('rotated');
    expect(new SecretBox('webhook-secrets', ['key-v2']).decrypt(box.encrypt('new'))).toBe('new');
  });
  it('signs the timestamp and body together', () => {
    const sig = signPayload('s3cret', 1700000000, '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature('s3cret', 1700000000, '{"a":1}', sig)).toBe(true);
    expect(verifySignature('s3cret', 1700000001, '{"a":1}', sig)).toBe(false);
    expect(verifySignature('s3cret', 1700000000, '{"a":2}', sig)).toBe(false);
    expect(verifySignature('other', 1700000000, '{"a":1}', sig)).toBe(false);
    expect(verifySignature('s3cret', 1700000000, '{"a":1}', 'short')).toBe(false);
  });
});
