import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Membership, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { TaskAccessService } from '../tasks/task-access.service.js';
import { taskKey } from '../tasks/task-ref.js';
import { timeSpentByTask } from '../tasks/time-spent.js';
import type { LogTimeDto, TaskTimeDto, TimeEntryDto, TimerDto, UpdateTimeEntryDto } from './dto/time.dto.js';

const include = { task: { select: { id: true, projectId: true, number: true, title: true, project: { select: { key: true, workspaceId: true } } } }, user: { select: { id: true, name: true } } } satisfies Prisma.TimeEntryInclude;
type Row = Prisma.TimeEntryGetPayload<{ include: typeof include }>;

const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002';
const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));

@Injectable()
export class TimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TaskAccessService,
    private readonly projects: ProjectAccessService,
  ) {}

  /**
   * Projects among these entries' tasks the person can no longer see (removed from a private
   * project, say). Their own entries stay, but must not reveal the task's current title or key.
   */
  private async hiddenProjectIds(userId: string, rows: Row[]): Promise<Set<string>> {
    const projectIds = [...new Set(rows.map((r) => r.task.projectId))];
    if (projectIds.length === 0) return new Set();
    const memberships = await this.prisma.membership.findMany({ where: { userId, workspaceId: { in: [...new Set(rows.map((r) => r.task.project.workspaceId))] } } });
    const visible = memberships.length === 0 ? [] : await this.prisma.project.findMany({
      where: { id: { in: projectIds }, OR: memberships.map((m) => ({ workspaceId: m.workspaceId, ...this.projects.visibleProjects(m) })) }, select: { id: true },
    });
    const ok = new Set(visible.map((p) => p.id));
    return new Set(projectIds.filter((id) => !ok.has(id)));
  }

  private async dtos(userId: string, rows: Row[], now: Date): Promise<TimeEntryDto[]> {
    const hidden = await this.hiddenProjectIds(userId, rows);
    return rows.map((r) => this.toDto(r, now, hidden.has(r.task.projectId)));
  }

  private toDto(r: Row, now: Date, redact = false): TimeEntryDto {
    const running = r.endedAt === null;
    return {
      id: r.id, taskId: r.taskId, taskKey: redact ? 'Restricted' : taskKey(r.task.project.key, r.task.number), taskTitle: redact ? 'Task you can no longer access' : r.task.title, userId: r.userId, userName: r.user.name,
      startedAt: r.startedAt, endedAt: r.endedAt, minutes: running ? minutesBetween(r.startedAt, now) : r.minutes, running, note: r.note,
    };
  }

  async forTask(m: Membership, ref: string, now = new Date()): Promise<TaskTimeDto> {
    const { task } = await this.access.load(m, ref);
    const rows = await this.prisma.timeEntry.findMany({ where: { taskId: task.id }, include, orderBy: { startedAt: 'desc' } });
    const spent = (await timeSpentByTask(this.prisma, [task.id], now)).get(task.id) ?? 0;
    return { estimateMinutes: task.timeEstimateMinutes, spentMinutes: spent, entries: rows.map((r) => this.toDto(r, now)) };
  }

  async log(m: Membership, ref: string, dto: LogTimeDto, now = new Date()): Promise<TimeEntryDto> {
    const { task } = await this.access.load(m, ref, { write: true });
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : new Date(now.getTime() - dto.minutes * 60_000);
    if (startedAt.getTime() > now.getTime() + 60_000) throw new BadRequestException('Time cannot be logged in the future');
    const row = await this.prisma.timeEntry.create({
      data: { taskId: task.id, userId: m.userId, startedAt, endedAt: new Date(startedAt.getTime() + dto.minutes * 60_000), minutes: dto.minutes, note: dto.note?.trim() || null },
      include,
    });
    return this.toDto(row, now);
  }

  private async ownEntry(m: Membership, ref: string, entryId: string) {
    const { task, manage } = await this.access.load(m, ref, { write: true });
    const entry = await this.prisma.timeEntry.findFirst({ where: { id: entryId, taskId: task.id }, include });
    if (!entry) throw new NotFoundException('Time entry not found');
    if (entry.userId !== m.userId && !manage) throw new ForbiddenException('Only the person who logged it or a project admin can change this entry');
    if (entry.endedAt === null) throw new BadRequestException('Stop the timer before changing this entry');
    return entry;
  }

  async update(m: Membership, ref: string, entryId: string, dto: UpdateTimeEntryDto, now = new Date()): Promise<TimeEntryDto> {
    const entry = await this.ownEntry(m, ref, entryId);
    const minutes = dto.minutes ?? entry.minutes;
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : entry.startedAt;
    if (startedAt.getTime() > now.getTime() + 60_000) throw new BadRequestException('Time cannot be logged in the future');
    const row = await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: { minutes, startedAt, endedAt: new Date(startedAt.getTime() + minutes * 60_000), ...(dto.note !== undefined && { note: dto.note?.trim() || null }) },
      include,
    });
    return this.toDto(row, now);
  }

  async remove(m: Membership, ref: string, entryId: string) {
    await this.ownEntry(m, ref, entryId);
    await this.prisma.timeEntry.delete({ where: { id: entryId } });
  }

  // ---------------------------------------------------------------- timer

  async timer(m: Membership, now = new Date()): Promise<TimerDto> {
    const row = await this.prisma.timeEntry.findFirst({ where: { userId: m.userId, endedAt: null, task: { project: { workspaceId: m.workspaceId } } }, include });
    return { entry: row ? (await this.dtos(m.userId, [row], now))[0] : null };
  }

  /**
   * Closes the person's running timer, dropping it if it ran for under a minute. A full session
   * may close the timer of any workspace (there is only one per person); a credential bound to one
   * workspace may only touch a timer running in that workspace.
   */
  private async stopRunning(userId: string, now: Date, onlyWorkspaceId?: string): Promise<Row | null> {
    const running = await this.prisma.timeEntry.findFirst({
      where: { userId, endedAt: null, ...(onlyWorkspaceId && { task: { project: { workspaceId: onlyWorkspaceId } } }) },
      include,
    });
    if (!running) return null;
    const minutes = minutesBetween(running.startedAt, now);
    if (minutes < 1) {
      await this.prisma.timeEntry.delete({ where: { id: running.id } });
      return null;
    }
    return this.prisma.timeEntry.update({ where: { id: running.id }, data: { endedAt: now, minutes: Math.min(minutes, 1440) }, include });
  }

  async start(m: Membership, ref: string, now = new Date(), opts: { boundToWorkspace?: boolean } = {}): Promise<TimerDto> {
    const { task } = await this.access.load(m, ref, { write: true });
    if (opts.boundToWorkspace) {
      // Not this credential's business: it must not end (or learn about) a timer elsewhere.
      const elsewhere = await this.prisma.timeEntry.findFirst({
        where: { userId: m.userId, endedAt: null, NOT: { task: { project: { workspaceId: m.workspaceId } } } }, select: { id: true },
      });
      if (elsewhere) throw new ConflictException('A timer is already running');
    }
    await this.stopRunning(m.userId, now, opts.boundToWorkspace ? m.workspaceId : undefined);
    try {
      const row = await this.prisma.timeEntry.create({ data: { taskId: task.id, userId: m.userId, startedAt: now }, include });
      return { entry: this.toDto(row, now) };
    } catch (e) {
      if (isUnique(e)) throw new ConflictException('A timer is already running; try again');
      throw e;
    }
  }

  async stop(m: Membership, now = new Date(), opts: { boundToWorkspace?: boolean } = {}): Promise<TimeEntryDto | null> {
    const row = await this.stopRunning(m.userId, now, opts.boundToWorkspace ? m.workspaceId : undefined);
    return row ? (await this.dtos(m.userId, [row], now))[0] : null;
  }

  /** The caller's own entries in a period (default: the last 7 days) across the workspace. */
  async mine(m: Membership, from?: string, to?: string, now = new Date()): Promise<TimeEntryDto[]> {
    const rows = await this.prisma.timeEntry.findMany({
      where: {
        userId: m.userId, task: { project: { workspaceId: m.workspaceId } },
        startedAt: { gte: from ? new Date(from) : new Date(now.getTime() - 7 * 86_400_000), ...(to ? { lte: new Date(to) } : {}) },
      },
      include, orderBy: { startedAt: 'desc' }, take: 500,
    });
    return this.dtos(m.userId, rows, now);
  }
}
