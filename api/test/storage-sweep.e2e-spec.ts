import { mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { OrphanSweepService } from '../src/storage/orphan-sweep.service.js';
import { createTestApp, createWorkspace, resetDatabase, signUp, type FakeMailService } from './helpers.js';

const uploadDir = process.env.UPLOAD_DIR!; // set in vitest.config.e2e.ts

describe('Storage orphan sweep (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mail: FakeMailService;
  beforeAll(async () => ({ app, prisma, mail } = await createTestApp()));
  afterAll(() => app.close());

  const put = (key: string, ageHours: number) => {
    const path = join(uploadDir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'x');
    const t = new Date(Date.now() - ageHours * 3600_000);
    utimesSync(path, t, t);
  };

  it('deletes old files nothing points to, and keeps attached or recent ones', async () => {
    await resetDatabase(prisma);
    const alice = await signUp(app, 'Alice');
    const ws = await createWorkspace(app, mail, alice);
    const project = await prisma.project.create({ data: { workspaceId: ws, name: 'P', key: 'PP', leadId: alice.id } });
    const status = await prisma.projectStatus.create({ data: { projectId: project.id, name: 'To do', category: 'TODO', position: 0 } });
    const task = await prisma.task.create({ data: { projectId: project.id, number: 1, title: 't', statusId: status.id, reporterId: alice.id, position: 1 } });
    const keys = {
      attached: `${ws}/${task.id}/${randomUUID()}`,
      orphanOld: `${ws}/${task.id}/${randomUUID()}`,
      chatOrphanOld: `${ws}/chat/${randomUUID()}/${randomUUID()}`,
      orphanRecent: `${ws}/${task.id}/${randomUUID()}`, // may still be on its way to being attached
      notOurs: 'backups/2026-11-01.sql.gz', // a shared bucket's other contents
    };
    await prisma.attachment.create({ data: { taskId: task.id, uploaderId: alice.id, filename: 'a.txt', storageKey: keys.attached, mimeType: 'text/plain', size: 1 } });
    put(keys.attached, 72);
    put(keys.orphanOld, 72);
    put(keys.chatOrphanOld, 72);
    put(keys.orphanRecent, 1);
    put(keys.notOurs, 72);

    const result = await app.get(OrphanSweepService).sweep();
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    const exists = (k: string) => existsSync(join(uploadDir, k));
    expect(exists(keys.attached)).toBe(true);
    expect(exists(keys.orphanOld)).toBe(false);
    expect(exists(keys.chatOrphanOld)).toBe(false);
    expect(exists(keys.orphanRecent)).toBe(true);
    expect(exists(keys.notOurs)).toBe(true);
  });
});
