import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomToken, sha256 } from '../common/crypto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ApiTokenDto, CreatedApiTokenDto } from './dto/api-token.dto.js';
import { AuthEvents, tokenCredentialId, type CredentialsRevokedEvent } from './events.js';
import { API_TOKEN_PREFIX } from './jwt-auth.guard.js';

@Injectable()
export class ApiTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async create(
    userId: string,
    name: string,
    expiresAt?: string,
    opts: { scopes?: ('read' | 'write')[]; workspaceId?: string } = {},
  ): Promise<CreatedApiTokenDto> {
    // A token outlives sessions: only someone who proved the address may create one.
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { emailVerifiedAt: true } });
    if (!owner.emailVerifiedAt) throw new ForbiddenException('Verify your email address before creating API tokens');
    if (opts.workspaceId && !(await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId: opts.workspaceId, userId } } }))) {
      throw new BadRequestException('You are not a member of that workspace');
    }
    // Writing implies reading.
    const scopes = opts.scopes?.includes('write') || !opts.scopes ? ['read', 'write'] : ['read'];
    const token = `${API_TOKEN_PREFIX}${randomToken(32)}`;
    const row = await this.prisma.apiToken.create({
      data: {
        userId,
        name: name.trim(),
        tokenHash: sha256(token),
        prefix: token.slice(0, 12),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        scopes,
        workspaceId: opts.workspaceId ?? null,
      },
    });
    return { ...this.toDto(row), token };
  }

  async list(userId: string): Promise<ApiTokenDto[]> {
    const rows = await this.prisma.apiToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async revoke(userId: string, id: string) {
    const res = await this.prisma.apiToken.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Token not found');
    this.events.emit(AuthEvents.credentialsRevoked, { credentialId: tokenCredentialId(id) } satisfies CredentialsRevokedEvent);
  }

  private toDto(r: {
    id: string; name: string; prefix: string;
    lastUsedAt: Date | null; expiresAt: Date | null; createdAt: Date; scopes: string[]; workspaceId: string | null;
  }): ApiTokenDto {
    return {
      id: r.id, name: r.name, prefix: r.prefix,
      lastUsedAt: r.lastUsedAt, expiresAt: r.expiresAt, createdAt: r.createdAt,
      scopes: r.scopes.filter((x): x is 'read' | 'write' => x === 'read' || x === 'write'), workspaceId: r.workspaceId,
    };
  }
}
