import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { sha256 } from '../common/crypto.js';
import type { ApiTokenScope, AuthUser } from '../common/decorators.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { sessionCredentialId, tokenCredentialId } from './events.js';
import { JwtKeyRing, previousSecrets } from './jwt-keys.js';

export const API_TOKEN_PREFIX = 'sqx_';

export interface Authenticated extends AuthUser {
  /** When the credential stops being valid (JWTs only), as epoch milliseconds. */
  expiresAt?: number;
  /** Identifies the session or API token behind the connection, for revocation. */
  credentialId?: string;
}

/** Validates a bearer credential (session JWT or personal API token). Shared by HTTP and WebSocket auth. */
@Injectable()
export class AuthTokenService {
  private readonly keys: JwtKeyRing;

  constructor(
    jwt: JwtService,
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.keys = new JwtKeyRing(jwt, config.get('JWT_ACCESS_SECRET'), previousSecrets(config.get('JWT_ACCESS_SECRET_PREVIOUS')));
  }

  authenticate(token: string): Promise<Authenticated> {
    return token.startsWith(API_TOKEN_PREFIX) ? this.fromApiToken(token) : this.fromJwt(token);
  }

  private async fromJwt(token: string): Promise<Authenticated> {
    const payload = await this.keys.verify<{ sub: string; sid: string; exp: number }>(token);
    if (!payload) throw new UnauthorizedException();

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.userId !== payload.sub) {
      throw new UnauthorizedException();
    }
    return {
      id: session.user.id,
      email: session.user.email,
      sessionId: session.id,
      credentialId: sessionCredentialId(session.id),
      via: 'jwt',
      expiresAt: payload.exp * 1000,
    };
  }

  private async fromApiToken(token: string): Promise<Authenticated> {
    const row = await this.prisma.apiToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date())) {
      throw new UnauthorizedException();
    }
    // Best-effort usage tracking; not worth failing the request.
    void this.prisma.apiToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return {
      id: row.user.id,
      email: row.user.email,
      via: 'api-token',
      credentialId: tokenCredentialId(row.id),
      expiresAt: row.expiresAt?.getTime(),
      scopes: row.scopes.filter((s): s is ApiTokenScope => s === 'read' || s === 'write'),
      tokenWorkspaceId: row.workspaceId ?? undefined,
    };
  }
}
