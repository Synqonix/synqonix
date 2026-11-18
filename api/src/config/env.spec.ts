import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

describe('validateEnv', () => {
  it('applies defaults', () => {
    const env = validateEnv({ DATABASE_URL: 'postgresql://x', RESEND_API_KEY: 're_test' });
    expect(env.PORT).toBe(4000);
  });

  it('needs a Resend key to send email, except in tests', () => {
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://x' })).toThrow(/RESEND_API_KEY is required/);
    expect(validateEnv({ DATABASE_URL: 'postgresql://x', NODE_ENV: 'test' }).RESEND_API_KEY).toBeUndefined();
    const dev = validateEnv({ DATABASE_URL: 'postgresql://x', RESEND_API_KEY: 're_dev', RESEND_BASE_URL: 'http://localhost:6245' });
    expect(dev.RESEND_BASE_URL).toBe('http://localhost:6245');
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });
});

describe('validateEnv in production', () => {
  const ok = {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://x', WEB_URL: 'https://app.example.com', RESEND_API_KEY: 're_live',
    JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), ENCRYPTION_KEY: 'c'.repeat(32),
  };

  it('accepts a complete configuration', () => {
    expect(validateEnv(ok).NODE_ENV).toBe('production');
  });

  it('refuses the development secrets and a localhost web address', () => {
    expect(() => validateEnv({ ...ok, JWT_ACCESS_SECRET: undefined })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => validateEnv({ ...ok, JWT_REFRESH_SECRET: 'dev-refresh-secret-change-me' })).toThrow(/JWT_REFRESH_SECRET/);
    expect(() => validateEnv({ ...ok, JWT_REFRESH_SECRET: ok.JWT_ACCESS_SECRET })).toThrow(/differ/);
    expect(() => validateEnv({ ...ok, WEB_URL: 'http://localhost:3000' })).toThrow(/WEB_URL/);
  });

  it('requires long JWT secrets', () => {
    expect(() => validateEnv({ ...ok, JWT_ACCESS_SECRET: 'x'.repeat(31) })).toThrow(/JWT_ACCESS_SECRET must be at least 32/);
    expect(() => validateEnv({ ...ok, JWT_REFRESH_SECRET: 'y'.repeat(20) })).toThrow(/JWT_REFRESH_SECRET must be at least 32/);
  });

  it('requires its own ENCRYPTION_KEY', () => {
    expect(() => validateEnv({ ...ok, ENCRYPTION_KEY: undefined })).toThrow(/ENCRYPTION_KEY must be set/);
    expect(() => validateEnv({ ...ok, ENCRYPTION_KEY: 'dev-encryption-key-change-me-0000000000' })).toThrow(/ENCRYPTION_KEY must be set/);
    expect(() => validateEnv({ ...ok, ENCRYPTION_KEY: ok.JWT_REFRESH_SECRET })).toThrow(/differ from the JWT/);
    expect(() => validateEnv({ ...ok, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
  });
});

describe('validateEnv with empty values', () => {
  it('treats empty strings as unset', () => {
    const env = validateEnv({ DATABASE_URL: 'postgresql://x', NODE_ENV: 'test', METRICS_TOKEN: '', RESEND_API_KEY: '', PORT: '' });
    expect(env.METRICS_TOKEN).toBeUndefined();
    expect(env.PORT).toBe(4000);
  });
});

describe('validateEnv storage', () => {
  it('defaults to local disk and wants credentials for s3', () => {
    expect(validateEnv({ DATABASE_URL: 'postgresql://x', RESEND_API_KEY: 're_test' }).STORAGE_DRIVER).toBe('local');
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://x', RESEND_API_KEY: 're_test', STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
    const env = validateEnv({ DATABASE_URL: 'postgresql://x', RESEND_API_KEY: 're_test', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'https://s3.filebase.com' });
    expect(env.S3_FORCE_PATH_STYLE).toBe('1');
    expect(env.PRESIGN_TTL_SECONDS).toBe(300);
  });
});
