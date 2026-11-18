import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { JobLock } from '../src/redis/job-lock.js';
import { createTestApp, createWorkspace, resetDatabase, signUp, type FakeMailService } from './helpers.js';

/**
 * Two API instances sharing one database and one Redis, as in a scaled deployment. Needs a Redis
 * at E2E_REDIS_URL (CI provides one; locally: docker run -p 6390:6379 redis:7.4-alpine and
 * E2E_REDIS_URL=redis://localhost:6390). Skipped without it.
 */
vi.hoisted(() => {
  // Must be set before AppModule is imported: its configuration is read at import time.
  if (process.env.E2E_REDIS_URL) {
    process.env.REDIS_URL = process.env.E2E_REDIS_URL;
    process.env.REDIS_PREFIX = `sqx-test-${Date.now()}:`;
  }
});

describe.skipIf(!process.env.E2E_REDIS_URL)('Several API instances with Redis (e2e)', () => {
  let a: NestExpressApplication;
  let b: NestExpressApplication;
  let mail: FakeMailService;
  let prisma: PrismaService;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ({ app: a, mail, prisma } = await createTestApp());
    ({ app: b } = await createTestApp());
    await resetDatabase(prisma);
  });
  afterAll(async () => {
    sockets.forEach((s) => s.close());
    // Closing sockets starts presence checks that ask the other instance; let them finish before
    // shutting the instances down, or one answers on a closed Redis connection.
    await new Promise((r) => setTimeout(r, 500));
    await a.close();
    await b.close();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_PREFIX;
  });

  const urlOf = (app: NestExpressApplication) => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  async function connect(app: NestExpressApplication, token: string) {
    const s = io(urlOf(app), { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
    return s;
  }
  const ask = <T>(s: Socket, event: string, body: unknown) => new Promise<T>((res) => s.emit(event, body, res));
  const next = <T>(s: Socket, event: string, pred: (e: T) => boolean = () => true) =>
    new Promise<T>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no ${event} event`)), 5000);
      s.on(event, (e: T) => { if (pred(e)) { clearTimeout(t); res(e); } });
    });

  it('delivers realtime events to sockets connected to the other instance', async () => {
    const alice = await signUp(a, 'Alice');
    const ws = await createWorkspace(a, mail, alice);
    const project = (await request(a.getHttpServer()).post(`/api/v1/workspaces/${ws}/projects`).set(alice.auth).send({ name: 'Multi', key: 'MUL' }).expect(201)).body;

    const onB = await connect(b, alice.token);
    expect(await ask(onB, 'subscribe', { projectId: project.id })).toEqual({ ok: true });
    const heard = next<{ type: string; taskKey: string }>(onB, 'task', (e) => e.type === 'created');
    await request(a.getHttpServer()).post(`/api/v1/workspaces/${ws}/projects/${project.id}/tasks`).set(alice.auth).send({ title: 'Made on A' }).expect(201);
    expect((await heard).taskKey).toBe('MUL-1');
  });

  it('shows who is online across instances', async () => {
    const [alice, bob] = [await signUp(a, 'Ann'), await signUp(a, 'Ben')];
    const ws = await createWorkspace(a, mail, alice, [[bob, 'MEMBER']]);
    const onA = await connect(a, alice.token);
    await ask(onA, 'presence:subscribe', { workspaceId: ws });
    const announced = next<{ userId: string; online: boolean }>(onA, 'presence', (e) => e.userId === bob.id);

    const onB = await connect(b, bob.token);
    const res = await ask<{ ok: boolean; online: string[] }>(onB, 'presence:subscribe', { workspaceId: ws });
    expect(res.online.sort()).toEqual([alice.id, bob.id].sort());
    expect(await announced).toMatchObject({ userId: bob.id, online: true });

    const left = next<{ userId: string; online: boolean }>(onA, 'presence', (e) => e.userId === bob.id && !e.online);
    onB.close();
    expect(await left).toMatchObject({ online: false });
  });

  it('shares rate limits between instances', async () => {
    process.env.THROTTLE_DISABLED = '0';
    try {
      const codes: number[] = [];
      // 6 + 6 attempts (different emails, so the per-account lockout stays out of it) against a
      // limit of 10 per client: only a shared counter refuses the last ones.
      for (let i = 0; i < 12; i++) {
        const app = i % 2 === 0 ? a : b;
        codes.push((await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: `nobody${i}@example.com`, password: 'wrong-password' })).status);
      }
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
    } finally {
      process.env.THROTTLE_DISABLED = '1';
    }
  });

  it('reports Redis in the readiness check', async () => {
    expect((await request(a.getHttpServer()).get('/api/v1/health/ready').expect(200)).body).toMatchObject({ db: 'up', redis: 'up' });
  });

  it('keeps the lock while a job runs past its hold, so another instance cannot start it', async () => {
    let release!: () => void;
    const running = a.get(JobLock).runOnce('long-job', 1500, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 2500)); // well past the 1.5 s hold
    let ranOnB = false;
    await b.get(JobLock).runOnce('long-job', 1500, async () => { ranOnB = true; });
    release();
    await running;
    expect(ranOnB).toBe(false);
  });

  it('runs a scheduled job on one instance only', async () => {
    let runs = 0;
    const job = async () => { runs++; await new Promise((r) => setTimeout(r, 50)); };
    await Promise.all([a.get(JobLock).runOnce('test-job', 2000, job), b.get(JobLock).runOnce('test-job', 2000, job)]);
    expect(runs).toBe(1);
  });
});

describe('Scheduled jobs', () => {
  it('are all still registered after being wrapped to run once', async () => {
    const { app } = await createTestApp();
    try {
      expect(app.get(SchedulerRegistry).getCronJobs().size).toBe(8);
    } finally {
      await app.close();
    }
  });
});
