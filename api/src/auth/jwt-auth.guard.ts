import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthedRequest, type AuthUser, IS_PUBLIC, REQUIRES_SESSION } from '../common/decorators.js';
import { AuthTokenService } from './auth-token.service.js';

export { API_TOKEN_PREFIX } from './auth-token.service.js';

/** Global guard: accepts a session JWT or a personal API token as `Authorization: Bearer`. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AuthTokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // WebSocket connections authenticate in the gateway's handshake middleware instead.
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw new UnauthorizedException();

    req.user = await this.tokens.authenticate(token);

    if (req.user.via === 'api-token') {
      if (this.reflector.getAllAndOverride<boolean>(REQUIRES_SESSION, targets)) {
        throw new ForbiddenException('This action requires a signed-in session');
      }
      const workspaceId = req.params?.workspaceId;
      checkTokenLimits(req.user, req.method, typeof workspaceId === 'string' ? workspaceId : undefined, req.path);
    }
    return true;
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Routes outside a workspace that a workspace-bound token may still read (their results are filtered to it). */
const BOUND_TOKEN_ROUTES = new Set(['/api/v1/users/me', '/api/v1/workspaces']);
/** The notification inbox: its controller keeps a bound token inside the token's workspace. */
const BOUND_TOKEN_PREFIX = '/api/v1/notifications';

/** Enforces an API token's scopes and workspace binding. Exported for tests. */
export function checkTokenLimits(user: AuthUser, method: string, workspaceId: string | undefined, path: string) {
  if (!READ_METHODS.has(method.toUpperCase()) && !user.scopes?.includes('write')) {
    throw new ForbiddenException('This API token is read-only');
  }
  if (!user.tokenWorkspaceId) return;
  const route = path.replace(/\/$/, '');
  const allowed = workspaceId !== undefined
    ? workspaceId === user.tokenWorkspaceId
    : (READ_METHODS.has(method.toUpperCase()) && BOUND_TOKEN_ROUTES.has(route)) ||
      route === BOUND_TOKEN_PREFIX || route.startsWith(`${BOUND_TOKEN_PREFIX}/`);
  if (!allowed) throw new ForbiddenException('This API token only works in its own workspace');
}
