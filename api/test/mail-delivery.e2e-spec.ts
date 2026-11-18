import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { MailService } from '../src/mail/mail.service.js';

/**
 * The real MailService (every other suite uses a fake) sending through the Resend SDK to Dev-Remail,
 * the same code path as production. Needs Dev-Remail at E2E_DEV_REMAIL_URL with `synqonix.local`
 * registered (docker-compose.dev.yml does both; CI provides one). Skipped without it.
 */
const BASE = process.env.E2E_DEV_REMAIL_URL;

describe.skipIf(!BASE)('Mail delivery through Resend (Dev-Remail)', () => {
  const env: Record<string, string> = {
    RESEND_API_KEY: 're_dev', RESEND_BASE_URL: BASE ?? '', MAIL_FROM: 'Synqonix <no-reply@synqonix.local>', WEB_URL: 'http://localhost:3000',
  };
  const mail = new MailService({ get: (k: string) => env[k] } as unknown as ConfigService<never, true>);
  const api = async <T>(path: string) => (await (await fetch(`${BASE}${path}`, { headers: { authorization: 'Bearer re_dev' } })).json()) as T;

  it('sends a verification email with a working link', async () => {
    const to = `mail-${Date.now()}@example.com`;
    await mail.sendVerificationEmail({ email: to, name: 'Ada' }, 'tok-123');

    const list = await api<{ data: { id: string; to: string[]; subject: string; created_at: string }[] }>('/emails?limit=100');
    const sent = list.data.filter((e) => e.to.includes(to));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Verify your Synqonix email');
    const full = await api<{ from: string; text: string; html: string }>(`/emails/${sent[0].id}`);
    expect(full.from).toBe('Synqonix <no-reply@synqonix.local>');
    expect(full.text).toContain('http://localhost:3000/verify-email?token=tok-123');
    expect(full.html).toContain('Verify email');
  });

  it('reports a failure instead of losing a notification', async () => {
    const broken = new MailService({ get: (k: string) => ({ ...env, MAIL_FROM: 'X <x@not-registered.example>' })[k] } as unknown as ConfigService<never, true>);
    await expect(broken.sendNotificationEmail('a@example.com', [{ title: 't', url: '/' }])).rejects.toThrow(/Resend error/);
  });
});
