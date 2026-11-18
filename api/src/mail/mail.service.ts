import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { Env } from '../config/env.js';
import {
  accountExistsTemplate, inviteTemplate, newSignInTemplate, notificationTemplate, type NotificationMailItem,
  resetPasswordTemplate, verifyEmailTemplate,
} from './mail.templates.js';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends email through Resend, the only transport. In development and CI, RESEND_BASE_URL points the
 * same SDK at Dev-Remail (a local Resend-compatible mailbox), so the code path is identical to production.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly webUrl: string;
  private readonly resend: Resend;

  constructor(config: ConfigService<Env, true>) {
    this.from = config.get('MAIL_FROM');
    this.webUrl = config.get('WEB_URL');
    const baseUrl = config.get('RESEND_BASE_URL');
    // The test suites replace this service; elsewhere env validation guarantees a key.
    this.resend = new Resend(config.get('RESEND_API_KEY') ?? 're_unset', baseUrl ? { baseUrl } : undefined);
  }

  async send(message: MailMessage): Promise<void> {
    const { error } = await this.resend.emails.send({ from: this.from, ...message });
    if (error) throw new Error(`Resend error: ${error.message}`);
  }

  /** Throws on failure, so callers can keep notifications queued and retry. */
  sendNotificationEmail(to: string, items: NotificationMailItem[]) {
    return this.send({ to, ...notificationTemplate(items, this.webUrl) });
  }

  /** Email delivery must never break the request that triggered it. */
  private async safeSend(message: MailMessage) {
    try {
      await this.send(message);
    } catch (err) {
      this.logger.error(`Failed to send "${message.subject}" to ${message.to}`, err as Error);
    }
  }

  sendVerificationEmail(user: { email: string; name: string }, token: string) {
    const url = `${this.webUrl}/verify-email?token=${encodeURIComponent(token)}`;
    return this.safeSend({ to: user.email, ...verifyEmailTemplate(user.name, url) });
  }

  sendPasswordResetEmail(user: { email: string; name: string }, token: string) {
    const url = `${this.webUrl}/reset-password?token=${encodeURIComponent(token)}`;
    return this.safeSend({ to: user.email, ...resetPasswordTemplate(user.name, url) });
  }

  sendAccountExistsEmail(user: { email: string; name: string }) {
    return this.safeSend({ to: user.email, ...accountExistsTemplate(user.name, `${this.webUrl}/login`) });
  }

  sendNewSignInEmail(user: { email: string; name: string }, device: string, ip: string) {
    return this.safeSend({ to: user.email, ...newSignInTemplate(user.name, device, ip, `${this.webUrl}/settings/security`) });
  }

  sendInvitationEmail(to: string, inviter: string, workspace: string, token: string) {
    const url = `${this.webUrl}/invitations/${encodeURIComponent(token)}`;
    return this.safeSend({ to, ...inviteTemplate(inviter, workspace, url) });
  }
}
