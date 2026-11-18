import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { Env } from '../config/env.js';
import { isPrivateAddress } from './url-guard.js';

export interface SendRequest { url: string; headers: Record<string, string>; body: string; timeoutMs: number }
export interface SendResult { status: number }

/** Delivers one request. Abstract so tests can replace the network. */
export abstract class WebhookSender {
  abstract send(req: SendRequest): Promise<SendResult>;
}

/**
 * Sends with node's http(s) client and a custom DNS lookup that refuses private addresses, so the
 * check applies to the address actually connected to (no DNS-rebinding gap) and to every redirect
 * target (redirects are not followed at all).
 */
@Injectable()
export class HttpWebhookSender extends WebhookSender {
  private readonly allowPrivate: boolean;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.allowPrivate = config.get('WEBHOOKS_ALLOW_PRIVATE_TARGETS') === '1';
  }

  send({ url, headers, body, timeoutMs }: SendRequest): Promise<SendResult> {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const allowPrivate = this.allowPrivate;
    return new Promise((resolve, reject) => {
      let settled = false;
      // `timeout` below only fires on silence; a receiver that keeps trickling bytes would hold the
      // delivery forever, so the whole exchange also has a hard deadline.
      const deadline = setTimeout(() => req.destroy(new Error('Timed out')), timeoutMs);
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      const req = client.request(
        target,
        {
          method: 'POST', timeout: timeoutMs, headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
          lookup: (host, options, cb) => {
            dnsLookup(host, { ...options, all: false }, (err, address, family) => {
              if (err) return cb(err, '', 4);
              if (!allowPrivate && isPrivateAddress(address as string)) return cb(new Error('Target resolves to a private address'), '', 4);
              cb(null, address as string, family as number);
            });
          },
        },
        (res) => {
          // The status is all that matters: answer now and drop the body instead of reading it.
          const status = res.statusCode ?? 0;
          done(() => resolve({ status }));
          res.destroy();
        },
      );
      req.on('timeout', () => req.destroy(new Error('Timed out')));
      req.on('error', (err) => done(() => reject(err)));
      req.on('close', () => done(() => reject(new Error('Connection closed before a response'))));
      req.end(body);
    });
  }
}
