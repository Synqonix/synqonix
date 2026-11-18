import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HOLD, RunOnce } from '../redis/job-lock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService, type StoredObject } from './storage.service.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * The only keys Synqonix writes: `<workspace>/<task>/<file>` (task attachments) and
 * `<workspace>/chat/<channel>/<file>` (chat files). Anything else in the bucket is not ours and is
 * never touched, even when the bucket is shared with other data.
 */
export const OWN_KEY = new RegExp(`^${UUID}/(?:chat/)?${UUID}/${UUID}$`, 'i');

/** Uploads younger than this may still be on their way to being attached; never touch them. */
export const ORPHAN_GRACE_MS = 24 * 3600_000;
const BATCH = 500;

/**
 * Deletes stored files no attachment points to any more: uploads that were never attached, and
 * files whose delete failed when their task or message went away. Without it they would count
 * against storage forever.
 */
@Injectable()
export class OrphanSweepService {
  private readonly logger = new Logger(OrphanSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async sweep(now = new Date()): Promise<{ checked: number; deleted: number }> {
    const cutoff = now.getTime() - ORPHAN_GRACE_MS;
    let checked = 0;
    let deleted = 0;
    let batch: StoredObject[] = [];
    const flush = async () => {
      const keys = batch.map((o) => o.key);
      batch = [];
      const [task, chat] = await Promise.all([
        this.prisma.attachment.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } }),
        this.prisma.messageAttachment.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } }),
      ]);
      const used = new Set([...task, ...chat].map((r) => r.storageKey));
      for (const key of keys) {
        if (used.has(key)) continue;
        await this.storage.delete(key);
        deleted++;
      }
    };
    for await (const obj of this.storage.list()) {
      if (!OWN_KEY.test(obj.key)) continue;
      checked++;
      if (obj.lastModified.getTime() > cutoff) continue;
      batch.push(obj);
      if (batch.length >= BATCH) await flush();
    }
    if (batch.length) await flush();
    return { checked, deleted };
  }

  @Cron('41 3 * * *')
  @RunOnce('storage-sweep', HOLD.day)
  async nightly() {
    try {
      const r = await this.sweep();
      this.logger.log(`Storage sweep checked ${r.checked} files, deleted ${r.deleted} orphans`);
    } catch (err) {
      this.logger.error('Storage sweep failed', err as Error);
    }
  }
}
