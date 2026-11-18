import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp, createWorkspace, resetDatabase, signUp, type FakeMailService, type TestUser } from './helpers.js';

interface Msg { channelId: string; message: { body: string } }

describe('Realtime security (e2e)', () => {
  let app: NestExpressApplication;
  let mail: FakeMailService;
  let prisma: PrismaService;
  let url: string;
  let alice: TestUser, bob: TestUser, carol: TestUser;
  let ws: string;
  let sockets: Socket[] = [];
  const http = () => request(app.getHttpServer());
  const api = (p: string) => `/api/v1/workspaces/${ws}${p}`;

  beforeAll(async () => {
    ({ app, mail, prisma } = await createTestApp());
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDatabase(prisma);
    [alice, bob, carol] = [await signUp(app, 'Alice'), await signUp(app, 'Bob'), await signUp(app, 'Carol')];
    ws = await createWorkspace(app, mail, alice, [[bob, 'MEMBER'], [carol, 'ADMIN']]);
  });
  afterEach(() => { sockets.forEach((s) => s.close()); sockets = []; });

  async function connect(token: string) {
    const s = io(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    const messages: Msg[] = [];
    const disconnected = new Promise<string>((res) => s.on('disconnect', res));
    s.on('message', (e: Msg) => messages.push(e));
    await new Promise<void>((resolve, reject) => { s.on('connect', resolve); s.on('connect_error', reject); });
    await new Promise((r) => setTimeout(r, 150));
    return { s, messages, disconnected };
  }
  const within = <T>(p: Promise<T>, ms = 3000) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
  const quiet = (ms = 300) => new Promise((r) => setTimeout(r, ms));

  it('disconnects a socket when its API token is revoked', async () => {
    const created = (await http().post('/api/v1/api-tokens').set(alice.auth).send({ name: 'ci' }).expect(201)).body;
    const c = await connect(created.token);
    await http().delete(`/api/v1/api-tokens/${created.id}`).set(alice.auth).expect(204);
    await within(c.disconnected);
    expect(c.s.connected).toBe(false);
  });

  it('disconnects a socket when its session is revoked', async () => {
    const sessions = (await http().get('/api/v1/auth/sessions').set(bob.auth).expect(200)).body as { id: string }[];
    const c = await connect(bob.token);
    await http().delete(`/api/v1/auth/sessions/${sessions[0].id}`).set(bob.auth).expect(204);
    await within(c.disconnected);
  });

  it('refuses a reconnect with a revoked token', async () => {
    const created = (await http().post('/api/v1/api-tokens').set(alice.auth).send({ name: 'ci' }).expect(201)).body;
    await http().delete(`/api/v1/api-tokens/${created.id}`).set(alice.auth).expect(204);
    await expect(connect(created.token)).rejects.toThrow();
  });

  it('does not bring back a private project channel for a demoted admin on reconnect', async () => {
    const project = (await http().post(api('/projects')).set(alice.auth).send({ name: 'Secret', key: 'SEC', template: 'SCRUM', visibility: 'PRIVATE' }).expect(201)).body;
    const channel = (await http().get(api('/channels')).set(alice.auth).expect(200)).body.find((c: { projectId: string }) => c.projectId === project.id);
    // Carol is a workspace admin, so she may follow the private project's channel.
    await http().post(api(`/channels/${channel.id}/join`)).set(carol.auth).expect(200);

    const before = await connect(carol.token);
    await http().post(api(`/channels/${channel.id}/messages`)).set(alice.auth).send({ body: 'one' }).expect(201);
    await quiet();
    expect(before.messages.map((m) => m.message.body)).toEqual(['one']);

    await http().patch(`/api/v1/workspaces/${ws}/members/${carol.id}`).set(alice.auth).send({ role: 'MEMBER' }).expect(200);
    await http().get(api(`/channels/${channel.id}`)).set(carol.auth).expect(404);

    const after = await connect(carol.token);
    await http().post(api(`/channels/${channel.id}/messages`)).set(alice.auth).send({ body: 'two' }).expect(201);
    await quiet();
    expect(after.messages).toEqual([]);
    expect(before.messages.map((m) => m.message.body)).toEqual(['one']);
    // The stored follow is gone as well, not just hidden at connect time.
    expect(await prisma.channelMember.count({ where: { channelId: channel.id, userId: carol.id } })).toBe(0);
  });

  it('does not leak channel read state to a token bound to another workspace', async () => {
    const other = (await http().post('/api/v1/workspaces').set(alice.auth).send({ name: 'Other' }).expect(201)).body;
    const ch = (await http().post(api('/channels')).set(alice.auth).send({ name: 'dev', type: 'PUBLIC' }).expect(201)).body;
    const bound = (await http().post('/api/v1/api-tokens').set(alice.auth).send({ name: 'bound', workspaceId: other.id }).expect(201)).body;
    const open = await connect(alice.token);
    const reads: unknown[] = [];
    const b = await connect(bound.token);
    b.s.on('channel:read', (e) => reads.push(e));
    open.s.on('channel:read', (e) => reads.push(e));
    await http().post(api(`/channels/${ch.id}/messages`)).set(alice.auth).send({ body: 'hi' }).expect(201);
    await http().post(api(`/channels/${ch.id}/read`)).set(alice.auth).send({}).expect(200);
    await quiet();
    expect(reads).toHaveLength(1); // only the unrestricted socket
  });

  it('rate-limits repeated expensive events and stays idempotent', async () => {
    const c = await connect(bob.token);
    const results = await Promise.all(
      Array.from({ length: 60 }, () => new Promise<{ ok: boolean; error?: string }>((res) => c.s.emit('presence:subscribe', { workspaceId: ws }, res))),
    );
    expect(results.some((r) => r.error === 'rate_limited')).toBe(true);
    expect(results.some((r) => r.ok)).toBe(true);
  });
});
