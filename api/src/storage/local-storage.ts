import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Env } from '../config/env.js';
import type { SignedTokens } from './signed-token.js';
import { type PresignedDownload, type PresignedUpload, StorageService, UPLOAD_CONTENT_TYPE, type StoredObject } from './storage.service.js';

/**
 * Disk storage for development and tests. It hands out the same kind of links as the S3 driver
 * (pointing at the API's `/storage/local` endpoints), so the web app has a single code path.
 */
export class LocalStorage extends StorageService {
  readonly driver = 'local' as const;
  readonly root: string;
  private readonly ttl: number;
  private readonly base: string;

  constructor(cfg: Pick<Env, 'UPLOAD_DIR' | 'PRESIGN_TTL_SECONDS' | 'API_PUBLIC_URL' | 'PORT'>, private readonly tokens: SignedTokens) {
    super();
    this.root = resolve(cfg.UPLOAD_DIR);
    this.ttl = cfg.PRESIGN_TTL_SECONDS;
    this.base = (cfg.API_PUBLIC_URL ?? `http://localhost:${cfg.PORT}`).replace(/\/+$/, '');
  }

  /** Resolves a storage key to a path, refusing anything that escapes the upload root. */
  pathFor(key: string): string {
    const full = resolve(this.root, key);
    const rel = relative(this.root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid storage key');
    return full;
  }

  async prepare(key: string): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    return path;
  }

  async presignUpload(key: string, size: number): Promise<PresignedUpload> {
    const token = this.tokens.sign({ op: 'put', key, size }, this.ttl);
    return {
      url: `${this.base}/api/v1/storage/local/upload?token=${token}`, method: 'PUT',
      headers: { 'Content-Type': UPLOAD_CONTENT_TYPE }, expiresAt: new Date(Date.now() + this.ttl * 1000).toISOString(),
    };
  }

  async presignDownload(key: string, filename: string): Promise<PresignedDownload> {
    const token = this.tokens.sign({ op: 'get', key, filename }, this.ttl);
    return { url: `${this.base}/api/v1/storage/local/download?token=${token}`, expiresAt: new Date(Date.now() + this.ttl * 1000).toISOString() };
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      return { size: (await stat(this.pathFor(key))).size };
    } catch {
      return null;
    }
  }

  async *list(): AsyncIterable<StoredObject> {
    let entries;
    try {
      entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    } catch {
      return; // nothing uploaded yet
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const path = resolve(e.parentPath, e.name);
      yield { key: relative(this.root, path).split('\\').join('/'), lastModified: (await stat(path)).mtime };
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
