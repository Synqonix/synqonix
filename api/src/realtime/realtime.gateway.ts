import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthTokenService, type Authenticated } from '../auth/auth-token.service.js';
import { AuthEvents, type CredentialsRevokedEvent } from '../auth/events.js';
import { TokenBucket, WindowCounter } from './rate-limit.js';
import { ChannelAccessService } from '../channels/channel-access.service.js';
import { ChannelsService } from '../channels/channels.service.js';
import {
  ChatEvents, ProjectEvents, WorkspaceEvents, type ChatAccessChangedEvent, type ChatChannelsChangedEvent, type ChatMemberEvent,
  type ChatMessageEvent, type ChatReadEvent, type ProjectMemberChangedEvent, type ProjectUpdatedEvent, type WorkspaceMemberRemovedEvent,
  type WorkspaceMemberRoleChangedEvent,
} from '../channels/events.js';
import { NotificationEvents, type NotificationChangedEvent } from '../notifications/events.js';
import { runAt } from '../common/long-timeout.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import {
  TaskEvents, type TaskEventBase, type TaskMovedEvent, type TaskRankedEvent,
} from '../tasks/events.js';

export type RealtimeTaskEvent = {
  type: 'created' | 'updated' | 'deleted' | 'ranked' | 'moved_out' | 'commented';
  taskId: string;
  taskKey: string;
  projectId: string;
  actorId: string;
  fields?: string[];
  statusId?: string;
};

export const projectRoom = (projectId: string) => `project:${projectId}`;
export const channelRoom = (channelId: string) => `channel:${channelId}`;
export const userRoom = (userId: string) => `user:${userId}`;
export const presenceRoom = (workspaceId: string) => `presence:${workspaceId}`;
/** Everything signed in with one session or API token (see AuthEvents.credentialsRevoked). */
export const credentialRoom = (credentialId: string) => `cred:${credentialId}`;
/** Sockets of an unrestricted credential: they hear about all the user's workspaces. */
export const userOpenRoom = (userId: string) => `uopen:${userId}`;
/** Sockets of a credential bound to one workspace: they only hear about that workspace. */
export const userWorkspaceRoom = (userId: string, workspaceId: string) => `uws:${userId}:${workspaceId}`;

const MAX_SOCKETS_PER_USER = 20;
const HANDSHAKES_PER_MINUTE_PER_IP = 60;
const REVALIDATE_INTERVAL_MS = 60_000;
/** Burst and refill for the events that touch the database or the other sockets. */
const EVENT_BURST = 20;
const EVENT_PER_SECOND = 5;
const MAX_IN_FLIGHT = 4;

/**
 * What travels with a socket. It must stay plain JSON: with Redis, other instances read it through
 * fetchSockets(), which serializes it.
 */
interface SocketData {
  user?: Authenticated;
}

/** Per-connection state that only this instance needs (timers, sets): never put on socket.data. */
interface LocalState {
  /** Cancels the disconnect scheduled for when the credential expires. */
  cancelExpiry?: () => void;
  /** Workspaces this socket reported presence in. */
  presence: Set<string>;
  lastTyping: Map<string, number>;
  events: TokenBucket;
  inFlight: number;
}

const TYPING_INTERVAL_MS = 1500;

/**
 * Pushes task changes to clients watching a project, so boards update live.
 * Clients authenticate with `auth: { token }` (session JWT or API token), then send
 * `subscribe` with `{ projectId }`; they receive `task` events for that room. Events carry
 * only identifiers: clients refetch what they display, so no data leaks past the HTTP rules.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server: Server;
  private readonly local = new WeakMap<object, LocalState>();
  private readonly handshakes = new WindowCounter(HANDSHAKES_PER_MINUTE_PER_IP, 60_000);
  private revalidateTimer?: NodeJS.Timeout;

  private localState(socket: object): LocalState {
    let state = this.local.get(socket);
    if (!state) this.local.set(socket, (state = { presence: new Set(), lastTyping: new Map(), events: new TokenBucket(EVENT_BURST, EVENT_PER_SECOND), inFlight: 0 }));
    return state;
  }

  constructor(
    private readonly tokens: AuthTokenService,
    private readonly prisma: PrismaService,
    private readonly projects: ProjectAccessService,
    private readonly channels: ChannelsService,
    private readonly channelAccess: ChannelAccessService,
  ) {}


  afterInit(server: Server) {
    server.use(async (socket, next) => {
      try {
        // Before any database work: a flood of handshakes must not turn into a flood of lookups.
        if (!this.handshakes.hit(socket.handshake.address)) throw new Error('rate limited');
        const token = socket.handshake.auth?.token;
        if (typeof token !== 'string' || !token) throw new Error('missing token');
        const user = await this.tokens.authenticate(token);
        const open = await server.in(userRoom(user.id)).fetchSockets();
        if (open.length >= MAX_SOCKETS_PER_USER) throw new Error('too many connections');
        const data = socket.data as SocketData;
        data.user = user;
        const local = this.localState(socket);
        // Access tokens are short-lived: drop the socket when this one expires; the client
        // reconnects with a fresh token.
        if (user.expiresAt) {
          // runAt, not setTimeout: API tokens may expire months away, beyond what setTimeout can hold.
          local.cancelExpiry = runAt(user.expiresAt, () => socket.disconnect(true));
          socket.on('disconnect', () => local.cancelExpiry?.());
        }
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
    // Backstop for revocations this instance never heard about (a missed event, another process).
    this.revalidateTimer = setInterval(() => {
      this.revalidateCredentials().catch((err: Error) => this.logger.warn(`Credential check failed: ${err.message}`));
    }, REVALIDATE_INTERVAL_MS);
    this.revalidateTimer.unref();
  }

  onModuleDestroy() {
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
  }

  /**
   * Disconnects sockets whose session or API token has been revoked (or has expired) since the
   * handshake. Every instance checks the sockets it holds.
   */
  private async revalidateCredentials() {
    if (!this.server) return;
    const sockets = [...this.server.sockets.sockets.values()];
    const sessions = new Map<string, Socket[]>();
    const tokens = new Map<string, Socket[]>();
    for (const socket of sockets) {
      const id = (socket.data as SocketData).user?.credentialId;
      if (!id) continue;
      const [kind, raw] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
      const bucket = kind === 'session' ? sessions : kind === 'token' ? tokens : undefined;
      bucket?.set(raw, [...(bucket.get(raw) ?? []), socket]);
    }
    if (sessions.size) {
      const live = await this.prisma.session.findMany({ where: { id: { in: [...sessions.keys()] }, revokedAt: null }, select: { id: true } });
      const alive = new Set(live.map((r) => r.id));
      for (const [id, group] of sessions) if (!alive.has(id)) group.forEach((s) => s.disconnect(true));
    }
    if (tokens.size) {
      const live = await this.prisma.apiToken.findMany({ where: { id: { in: [...tokens.keys()] }, revokedAt: null }, select: { id: true, expiresAt: true } });
      const alive = new Set(live.filter((r) => !r.expiresAt || r.expiresAt > new Date()).map((r) => r.id));
      for (const [id, group] of tokens) if (!alive.has(id)) group.forEach((s) => s.disconnect(true));
    }
  }

  /** A session or token was revoked: close its sockets now, on every instance. */
  @OnEvent(AuthEvents.credentialsRevoked)
  async onCredentialsRevoked(e: CredentialsRevokedEvent) {
    if (!this.server) return;
    if (e.credentialId) this.server.in(credentialRoom(e.credentialId)).disconnectSockets(true);
    if (!e.userId) return;
    for (const s of await this.userSockets(e.userId)) {
      if (e.exceptCredentialId && (s.data as SocketData).user?.credentialId === e.exceptCredentialId) continue;
      s.disconnect(true);
    }
  }

  /**
   * Cheap guard for events that cost a query or a broadcast: a per-socket budget plus a cap on
   * how many run at once, so one client cannot queue unbounded work.
   */
  private async limited<T>(client: object, cost: number, run: () => Promise<T>): Promise<T | { ok: false; error: 'rate_limited' }> {
    const local = this.localState(client);
    if (local.inFlight >= MAX_IN_FLIGHT || !local.events.take(cost)) return { ok: false, error: 'rate_limited' };
    local.inFlight += 1;
    try {
      return await run();
    } finally {
      local.inFlight -= 1;
    }
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { projectId?: unknown }) {
    const user = (client.data as SocketData).user;
    if (!user || typeof body?.projectId !== 'string') return { ok: false, error: 'bad_request' };
    const projectId = body.projectId;
    // Idempotent: a repeat costs nothing (access is rechecked when it changes).
    if (client.rooms.has(projectRoom(projectId))) return { ok: true };
    return this.limited(client, 1, async () => {
      if (!(await this.canSeeProject(user.id, projectId, user.tokenWorkspaceId))) return { ok: false, error: 'not_found' };
      await client.join(projectRoom(projectId));
      return { ok: true };
    });
  }

  /** The same rule as the HTTP API: workspace member and allowed to see the project (private projects included). */
  private async canSeeProject(userId: string, projectId: string, boundWorkspaceId?: string): Promise<boolean> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || (boundWorkspaceId && project.workspaceId !== boundWorkspaceId)) return false;
    const membership = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } } });
    if (!membership) return false;
    try {
      await this.projects.check(membership, project);
      return true;
    } catch {
      return false;
    }
  }

  // Access can be lost while a socket stays connected; these drop it from rooms it may no longer hear.

  /** Visibility or lead changed: re-check everyone watching the project. */
  @OnEvent(ProjectEvents.updated)
  async onProjectUpdated(e: ProjectUpdatedEvent) {
    await this.channelAccess.pruneProjectChannelMembers(e.projectId);
    await this.revalidateProject(e.projectId);
  }

  @OnEvent(ProjectEvents.memberChanged)
  async onProjectMemberChanged(e: ProjectMemberChangedEvent) {
    if (e.role === null) {
      await this.channelAccess.pruneMemberships(e.userId, e.workspaceId);
      await this.revalidateProject(e.projectId, e.userId);
      await this.revalidateUser(e.userId);
    }
  }

  /** Removed from the workspace: stop its project, channel and presence events for that user. */
  @OnEvent(WorkspaceEvents.memberRemoved)
  async onWorkspaceMemberRemoved(e: WorkspaceMemberRemovedEvent) {
    await this.revalidateUser(e.userId);
    for (const s of await this.userSockets(e.userId)) {
      // Sockets on other instances are remote handles; their own instance keeps their local state.
      s.leave(presenceRoom(e.workspaceId));
    }
    await this.announceIfOffline(e.workspaceId, e.userId);
  }

  /** A demoted admin no longer sees private projects they are not a member of, nor their channels. */
  @OnEvent(WorkspaceEvents.memberRoleChanged)
  async onWorkspaceRoleChanged(e: WorkspaceMemberRoleChangedEvent) {
    // Stored follows are cleaned up too, so a reconnect cannot bring the channel back.
    await this.channelAccess.pruneMemberships(e.userId, e.workspaceId);
    await this.revalidateUser(e.userId);
  }

  private async userSockets(userId: string) {
    return this.server ? this.server.in(userRoom(userId)).fetchSockets() : [];
  }

  private async revalidateProject(projectId: string, onlyUserId?: string) {
    if (!this.server) return;
    const room = projectRoom(projectId);
    const allowed = new Map<string, boolean>();
    for (const s of await this.server.in(room).fetchSockets()) {
      const userId = (s.data as SocketData).user?.id;
      if (!userId || (onlyUserId && userId !== onlyUserId)) continue;
      if (!allowed.has(userId)) allowed.set(userId, await this.canSeeProject(userId, projectId));
      if (!allowed.get(userId)) s.leave(room);
    }
  }

  /** Re-checks every project and channel room the user's sockets are in. */
  private async revalidateUser(userId: string) {
    const projectIds = new Set<string>();
    const channelIds = new Set<string>();
    for (const s of await this.userSockets(userId)) {
      for (const room of s.rooms) {
        if (room.startsWith('project:')) projectIds.add(room.slice('project:'.length));
        else if (room.startsWith('channel:')) channelIds.add(room.slice('channel:'.length));
      }
    }
    for (const id of projectIds) await this.revalidateProject(id, userId);
    for (const id of channelIds) await this.revalidate(id, userId);
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { projectId?: unknown }) {
    if (typeof body?.projectId === 'string' && this.localState(client).events.take(1)) await client.leave(projectRoom(body.projectId));
    return { ok: true };
  }

  private publish(projectId: string, e: TaskEventBase, type: RealtimeTaskEvent['type'], extra: Partial<RealtimeTaskEvent> = {}) {
    const payload: RealtimeTaskEvent = { type, taskId: e.taskId, taskKey: e.taskKey, projectId, actorId: e.actorId, ...extra };
    this.server?.to(projectRoom(projectId)).emit('task', payload);
  }

  @OnEvent(TaskEvents.created) onCreated(e: TaskEventBase) { this.publish(e.projectId, e, 'created'); }
  @OnEvent(TaskEvents.updated) onUpdated(e: TaskEventBase & { fields: string[] }) { this.publish(e.projectId, e, 'updated', { fields: e.fields }); }
  @OnEvent(TaskEvents.deleted) onDeleted(e: TaskEventBase) { this.publish(e.projectId, e, 'deleted'); }
  @OnEvent(TaskEvents.commented) onCommented(e: TaskEventBase) { this.publish(e.projectId, e, 'commented'); }
  @OnEvent(TaskEvents.ranked) onRanked(e: TaskRankedEvent) { this.publish(e.projectId, e, 'ranked', { statusId: e.statusId }); }
  @OnEvent(TaskEvents.moved) onMoved(e: TaskMovedEvent) {
    // The destination already hears about it through `updated`; tell the old project it left.
    // With the old key: the new one belongs to a project these listeners may not be able to see.
    this.publish(e.fromProjectId, { ...e, taskKey: e.fromTaskKey }, 'moved_out');
  }

  // ---------------------------------------------------------------- chat

  /** A connected user hears about every channel they follow and about their own read state. */
  async handleConnection(client: Socket) {
    const user = (client.data as SocketData).user;
    if (!user) return;
    await client.join(userRoom(user.id));
    if (user.credentialId) await client.join(credentialRoom(user.credentialId));
    await client.join(user.tokenWorkspaceId ? userWorkspaceRoom(user.id, user.tokenWorkspaceId) : userOpenRoom(user.id));
    // Following a channel is not proof of access (it can outlive a demotion), so every channel is
    // checked against the same visibility rules as the HTTP API before it is joined.
    const followed = await this.channels.memberChannelIds(user.id);
    const channelIds = await this.channelAccess.visibleChannelIds(user.id, followed, user.tokenWorkspaceId);
    await client.join(channelIds.map(channelRoom));
  }

  /** Whether this socket may act in a workspace (false for an API token bound to another one). */
  private inScope(client: { data: unknown }, workspaceId: string) {
    const bound = (client.data as SocketData).user?.tokenWorkspaceId;
    return !bound || bound === workspaceId;
  }

  handleDisconnect(client: Socket) {
    const data = client.data as SocketData;
    // The socket has already left its rooms; announce users whose last tab just closed.
    const local = this.localState(client);
    // Not awaited (the socket is gone), so failures must be caught here: an unhandled rejection
    // would take the whole process down.
    if (data.user) {
      for (const workspaceId of local.presence) {
        this.announceIfOffline(workspaceId, data.user.id).catch((err: Error) => this.logger.warn(`Presence update failed: ${err.message}`));
      }
    }
    local.presence.clear();
  }

  /** Starts receiving a channel you can see but do not follow (followed channels join automatically). */
  @SubscribeMessage('channel:subscribe')
  async subscribeChannel(@ConnectedSocket() client: Socket, @MessageBody() body: { workspaceId?: unknown; channelId?: unknown }) {
    const user = (client.data as SocketData).user;
    if (!user || typeof body?.workspaceId !== 'string' || typeof body?.channelId !== 'string') return { ok: false, error: 'bad_request' };
    if (!this.inScope(client, body.workspaceId)) return { ok: false, error: 'not_found' };
    const { workspaceId, channelId } = body;
    if (client.rooms.has(channelRoom(channelId))) return { ok: true };
    return this.limited(client, 1, async () => {
      const membership = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.id } } });
      if (!membership) return { ok: false, error: 'not_found' };
      try {
        await this.channelAccess.load(membership, channelId);
      } catch {
        return { ok: false, error: 'not_found' };
      }
      await client.join(channelRoom(channelId));
      return { ok: true };
    });
  }

  @SubscribeMessage('channel:unsubscribe')
  async unsubscribeChannel(@ConnectedSocket() client: Socket, @MessageBody() body: { channelId?: unknown }) {
    const user = (client.data as SocketData).user;
    if (!user || typeof body?.channelId !== 'string') return { ok: true };
    const channelId = body.channelId;
    return this.limited(client, 1, async () => {
      // Followed channels keep delivering (unread counts depend on it).
      const followed = await this.channels.memberChannelIds(user.id);
      if (!followed.includes(channelId)) await client.leave(channelRoom(channelId));
      return { ok: true };
    });
  }

  /** "Someone is typing": only from sockets that already passed the channel access check. */
  @SubscribeMessage('typing')
  typing(@ConnectedSocket() client: Socket, @MessageBody() body: { channelId?: unknown }) {
    const data = client.data as SocketData;
    if (!data.user || typeof body?.channelId !== 'string') return { ok: false };
    const room = channelRoom(body.channelId);
    if (!client.rooms.has(room)) return { ok: false };
    const last = this.localState(client).lastTyping;
    const now = Date.now();
    if (now - (last.get(room) ?? 0) < TYPING_INTERVAL_MS) return { ok: true };
    last.set(room, now);
    client.to(room).emit('typing', { channelId: body.channelId, userId: data.user.id });
    return { ok: true };
  }

  /** Reports the caller online in a workspace and returns who else is. */
  @SubscribeMessage('presence:subscribe')
  async subscribePresence(@ConnectedSocket() client: Socket, @MessageBody() body: { workspaceId?: unknown }) {
    const data = client.data as SocketData;
    if (!data.user || typeof body?.workspaceId !== 'string') return { ok: false, error: 'bad_request' };
    if (!this.inScope(client, body.workspaceId)) return { ok: false, error: 'not_found' };
    const workspaceId = body.workspaceId;
    const userId = data.user.id;
    // Listing everyone online enumerates sockets, so it costs more than a plain subscribe.
    return this.limited(client, 5, async () => {
      const membership = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (!membership) return { ok: false, error: 'not_found' };
      const set = this.localState(client).presence;
      const room = presenceRoom(workspaceId);
      if (!set.has(workspaceId)) {
        set.add(workspaceId);
        await client.join(room);
        // Announced on every join: clients keep a set, so a repeat is harmless, and there is no
        // "first tab" count to get wrong when several tabs or instances join at once.
        this.server.to(room).emit('presence', { workspaceId, userId, online: true });
      }
      // The full list is read from the sockets themselves (on every instance when Redis is on).
      return { ok: true, online: [...new Set(await this.onlineSockets(workspaceId))] };
    });
  }

  /** User ids of the sockets reporting presence in a workspace, one entry per socket. */
  private async onlineSockets(workspaceId: string): Promise<string[]> {
    if (!this.server) return [];
    const sockets = await this.server.in(presenceRoom(workspaceId)).fetchSockets();
    return sockets.map((s) => (s.data as SocketData).user?.id).filter((id): id is string => !!id);
  }

  /** Announces a user offline when none of their sockets (on any instance) still reports presence there. */
  private async announceIfOffline(workspaceId: string, userId: string) {
    // Only this user's sockets are fetched, not the whole workspace's.
    const room = presenceRoom(workspaceId);
    const mine = this.server ? await this.server.in(userRoom(userId)).fetchSockets() : [];
    if (mine.some((s) => s.rooms.has(room))) return;
    this.server?.to(presenceRoom(workspaceId)).emit('presence', { workspaceId, userId, online: false });
  }

  @OnEvent(ChatEvents.message)
  onChatMessage(e: ChatMessageEvent) {
    this.server?.to(channelRoom(e.channelId)).emit('message', { type: e.type, channelId: e.channelId, message: e.message });
  }

  @OnEvent(ChatEvents.read)
  onChatRead(e: ChatReadEvent) {
    // A token bound to another workspace must not learn which channels this user reads.
    this.server?.to([userOpenRoom(e.userId), userWorkspaceRoom(e.userId, e.workspaceId)]).emit('channel:read', { channelId: e.channelId, seq: e.seq });
  }

  @OnEvent(ChatEvents.channelsChanged)
  onChannelsChanged(e: ChatChannelsChangedEvent) {
    // Everyone listening in the workspace (they report presence there), or just the people named.
    const rooms = e.userIds ? e.userIds.flatMap((id) => [userOpenRoom(id), userWorkspaceRoom(id, e.workspaceId)]) : [presenceRoom(e.workspaceId)];
    this.server?.to(rooms).emit('channels:changed', { workspaceId: e.workspaceId });
  }

  /** Following a channel starts (or stops) its delivery to the user's open sockets. */
  @OnEvent(ChatEvents.member)
  async onChatMember(e: ChatMemberEvent) {
    const room = channelRoom(e.channelId);
    if (e.type === 'added') {
      for (const s of await this.userSockets(e.userId)) if (this.inScope(s, e.workspaceId)) s.join(room);
      return;
    }
    // Leaving a public channel still lets the user watch it if they have it open, but a removal
    // from a channel they can no longer see must stop delivery right away.
    await this.revalidate(e.channelId, e.userId);
  }

  @OnEvent(ChatEvents.accessChanged)
  async onAccessChanged(e: ChatAccessChangedEvent) {
    await this.revalidate(e.channelId);
  }

  /** Removes sockets from a channel room when their user can no longer see the channel. */
  private async revalidate(channelId: string, onlyUserId?: string) {
    if (!this.server) return;
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    const sockets = await this.server.in(channelRoom(channelId)).fetchSockets();
    for (const s of sockets) {
      const userId = (s.data as SocketData).user?.id;
      if (!userId || (onlyUserId && userId !== onlyUserId)) continue;
      const membership = channel ? await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } } }) : null;
      let allowed = false;
      if (membership) {
        try {
          await this.channelAccess.load(membership, channelId);
          allowed = true;
        } catch { /* hidden */ }
      }
      if (!allowed) s.leave(channelRoom(channelId));
    }
  }

  /** Tells the user's open tabs to refetch their inbox; the event carries no content. */
  @OnEvent(NotificationEvents.created)
  @OnEvent(NotificationEvents.changed)
  onNotification(e: NotificationChangedEvent) {
    this.server?.to(userRoom(e.userId)).emit('notification', {});
  }
}
