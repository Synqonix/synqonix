import { BadRequestException, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HOLD, RunOnce } from '../redis/job-lock.js';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';
import type { Membership } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { safeFilename } from '../tasks/attachments.service.js';
import { SignedTokens } from '../storage/signed-token.js';
import { DownloadUrlDto, RequestUploadDto, UploadTargetDto } from '../storage/storage.dto.js';
import { StorageService } from '../storage/storage.service.js';
import { ChannelAccessService } from './channel-access.service.js';
import type { MessageAttachmentDto } from './dto/channels.dto.js';

/** Files shared in chat: presigned upload, confirmation, download links and cleanup of abandoned uploads. */
@Injectable()
export class ChatFilesService {
  private readonly logger = new Logger(ChatFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly storage: StorageService,
    private readonly tokens: SignedTokens,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async requestUpload(m: Membership, channelId: string, dto: RequestUploadDto): Promise<UploadTargetDto> {
    await this.access.loadForPosting(m, channelId);
    const maxMb = this.config.get('MAX_UPLOAD_MB');
    if (dto.size > maxMb * 1024 * 1024) throw new PayloadTooLargeException(`Files can be at most ${maxMb} MB`);
    const filename = safeFilename(dto.filename);
    const key = `${m.workspaceId}/chat/${channelId}/${randomUUID()}`;
    const target = await this.storage.presignUpload(key, dto.size);
    const mimeType = dto.mimeType?.trim() || 'application/octet-stream';
    const uploadToken = this.tokens.sign({ kind: 'chat', key, filename, mimeType, size: dto.size, channel: channelId, user: m.userId }, 15 * 60);
    return { uploadUrl: target.url, method: target.method, headers: target.headers, expiresAt: target.expiresAt, uploadToken };
  }

  async confirmUpload(m: Membership, channelId: string, uploadToken: string): Promise<MessageAttachmentDto> {
    await this.access.loadForPosting(m, channelId);
    const c = this.tokens.verify<{ kind: string; key: string; filename: string; mimeType: string; size: number; channel: string; user: string }>(uploadToken);
    if (c.kind !== 'chat' || c.channel !== channelId || c.user !== m.userId) throw new BadRequestException('This upload does not belong to this channel');
    const toDto = (a: { id: string; filename: string; mimeType: string; size: number }): MessageAttachmentDto => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size });
    const existing = await this.prisma.messageAttachment.findFirst({ where: { storageKey: c.key } });
    if (existing) return toDto(existing);
    const stored = await this.storage.head(c.key);
    if (!stored) throw new BadRequestException('The file was not uploaded');
    if (stored.size !== c.size) {
      await this.storage.delete(c.key).catch(() => undefined);
      throw new BadRequestException('The uploaded file does not match the size that was announced');
    }
    const a = await this.prisma.messageAttachment.create({
      data: { channelId, uploaderId: m.userId, filename: c.filename, storageKey: c.key, mimeType: c.mimeType, size: c.size },
    });
    return toDto(a);
  }

  async downloadUrl(m: Membership, channelId: string, attachmentId: string): Promise<DownloadUrlDto> {
    await this.access.load(m, channelId);
    const a = await this.prisma.messageAttachment.findFirst({ where: { id: attachmentId, channelId } });
    // A file that has not been sent yet is only visible to the person who uploaded it.
    if (!a || (!a.messageId && a.uploaderId !== m.userId)) throw new NotFoundException('Attachment not found');
    return this.storage.presignDownload(a.storageKey, a.filename);
  }

  /** Files uploaded but never sent are removed after a day. */
  @Cron(CronExpression.EVERY_HOUR)
  @RunOnce('chat-upload-purge', HOLD.hour)
  async purgePendingUploads() {
    const stale = await this.prisma.messageAttachment.findMany({
      where: { messageId: null, createdAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } }, take: 500,
    });
    for (const a of stale) {
      await this.storage.delete(a.storageKey).catch(() => undefined);
      await this.prisma.messageAttachment.delete({ where: { id: a.id } }).catch(() => undefined);
    }
    if (stale.length > 0) this.logger.log(`Removed ${stale.length} unsent chat uploads`);
  }
}
