import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../common/decorators.js';
import { checkTokenLimits } from './jwt-auth.guard.js';

const token = (over: Partial<AuthUser> = {}): AuthUser => ({ id: 'u', email: 'u@x', via: 'api-token', scopes: ['read', 'write'], ...over });

describe('API token limits', () => {
  it('lets read-only tokens read but not change anything', () => {
    const ro = token({ scopes: ['read'] });
    expect(() => checkTokenLimits(ro, 'GET', 'w1', '/api/v1/workspaces/w1/tasks')).not.toThrow();
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(() => checkTokenLimits(ro, m, 'w1', '/api/v1/workspaces/w1/tasks'), m).toThrow(ForbiddenException);
    }
    expect(() => checkTokenLimits(token(), 'POST', 'w1', '/x')).not.toThrow();
  });

  it('keeps a workspace-bound token inside its workspace', () => {
    const bound = token({ tokenWorkspaceId: 'w1' });
    expect(() => checkTokenLimits(bound, 'POST', 'w1', '/api/v1/workspaces/w1/tasks')).not.toThrow();
    expect(() => checkTokenLimits(bound, 'GET', 'w2', '/api/v1/workspaces/w2/tasks')).toThrow(/its own workspace/);
    expect(() => checkTokenLimits(bound, 'GET', undefined, '/api/v1/users/me')).not.toThrow();
    expect(() => checkTokenLimits(bound, 'GET', undefined, '/api/v1/workspaces/')).not.toThrow();
    expect(() => checkTokenLimits(bound, 'POST', undefined, '/api/v1/workspaces')).toThrow(/its own workspace/);
    // The inbox is reachable; its controller keeps the token inside its workspace.
    expect(() => checkTokenLimits(bound, 'GET', undefined, '/api/v1/notifications')).not.toThrow();
    expect(() => checkTokenLimits(bound, 'POST', undefined, '/api/v1/notifications/n1/read')).not.toThrow();
    expect(() => checkTokenLimits(bound, 'GET', undefined, '/api/v1/notifications-elsewhere')).toThrow(/its own workspace/);
  });
});
