import { createServer as createHttp } from 'node:http';
import { createServer as createTcp, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpWebhookSender } from './webhook-sender.js';

const sender = new HttpWebhookSender({ get: () => '1' } as never);
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));
const listen = async (s: Server) => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`;
};
const req = (url: string, timeoutMs: number) => sender.send({ url, headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs });

describe('HttpWebhookSender', () => {
  it('answers with the status without waiting for the body', async () => {
    const url = await listen(createHttp((_req, res) => {
      res.writeHead(200);
      res.write('x');
      // never ends: the body keeps trickling
      const t = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(t));
    }));
    const started = Date.now();
    expect(await req(url, 2000)).toEqual({ status: 200 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('gives up at an absolute deadline even when the receiver keeps sending bytes', async () => {
    const url = await listen(createTcp((socket) => {
      socket.on('error', () => undefined);
      // A status line that never completes its headers, one byte at a time.
      const t = setInterval(() => socket.write('H'), 50);
      socket.on('close', () => clearInterval(t));
    }));
    const started = Date.now();
    await expect(req(url, 400)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('rejects when the connection drops without a response', async () => {
    const url = await listen(createTcp((socket) => { socket.on('error', () => undefined); socket.destroy(); }));
    await expect(req(url, 2000)).rejects.toThrow();
  });
});
