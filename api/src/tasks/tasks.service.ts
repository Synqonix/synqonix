import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Membership, Prisma, Project } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { ActivityService } from './activity.service.js';
import type { BulkChangesDto, CreateTaskDto, UpdateTaskDto } from './dto/task.dto.js';
import type { BulkResultDto, TaskDetailDto } from './dto/task-response.dto.js';
import { hierarchyError } from './hierarchy.js';
import { TaskEvents, type TaskEvent } from './events.js';
import { extractMentionedUserIds } from './mentions.js';
import { TaskAccessService } from './task-access.service.js';
import { refInclude, summaryInclude, toRefDto } from './task-mapper.js';
import { TaskSupportService } from './task-support.service.js';
import { POSITION_STEP } from './ranking.js';
import { taskKey } from './task-ref.js';
import { StorageService } from '../storage/storage.service.js';
import { TaskQueryService } from './task-query.service.js';
import { TaskUpdateService } from './task-update.service.js';


@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectAccessService,
    private readonly access: TaskAccessService,
    private readonly support: TaskSupportService,
    private readonly activity: ActivityService,
    private readonly events: EventEmitter2,
    private readonly storage: StorageService,
    private readonly query: TaskQueryService,
    private readonly updates: TaskUpdateService,
  ) {}

  private emit(events: TaskEvent[]) {
    for (const e of events) this.events.emit(e.name, e.payload);
  }

  // ---------- create ----------

  /** `silent` skips the domain events, for bulk imports that should not notify anyone. */
  async create(m: Membership, projectId: string, dto: CreateTaskDto, opts: { silent?: boolean } = {}): Promise<TaskDetailDto> {
    const { project } = await this.projects.load(m, projectId, { write: true });
    if (project.archivedAt) throw new BadRequestException('This project is archived');

    const events: TaskEvent[] = [];
    const created = await this.prisma.$transaction(async (tx) => {
      await this.support.lockProject(tx, project.id);
      const type = dto.type ?? 'TASK';
      const parent = dto.parentId ? await this.support.resolveParent(tx, project.id, dto.parentId) : null;
      const problem = hierarchyError(type, parent?.type ?? null);
      if (problem) throw new BadRequestException(problem);

      const status = await this.support.resolveStatus(tx, project.id, dto.statusId);
      const assigneeIds = await this.support.assertAssignees(tx, m.workspaceId, project, dto.assigneeIds ?? []);
      const labels = await this.support.assertLabels(tx, project.id, dto.labelIds ?? []);
      const defs = await this.support.customFieldDefs(tx, project.id);
      const custom = this.support.normalizeCustomInput(defs, dto.customFields ?? {});
      this.support.assertEstimate(project, dto.estimate);
      const sprint = dto.sprintId ? await this.support.resolveSprint(tx, project.id, dto.sprintId) : null;
      if (sprint && type === 'EPIC') throw new BadRequestException('Epics cannot be planned into a sprint');
      const release = dto.releaseId ? await this.support.resolveRelease(tx, project.id, dto.releaseId) : null;
      const milestone = dto.milestoneId ? await this.support.resolveMilestone(tx, project.id, dto.milestoneId) : null;

      // Atomic counter: concurrent creators each get a distinct number.
      const { nextTaskNumber } = await tx.project.update({
        where: { id: project.id },
        data: { nextTaskNumber: { increment: 1 } },
        select: { nextTaskNumber: true },
      });
      const last = await tx.task.aggregate({ where: { projectId: project.id }, _max: { position: true } });

      const task = await tx.task.create({
        data: {
          projectId: project.id,
          number: nextTaskNumber - 1,
          type,
          title: dto.title.trim(),
          description: dto.description?.trim() || null,
          statusId: status.id,
          priority: dto.priority ?? 'NONE',
          reporterId: m.userId,
          estimate: dto.estimate ?? null,
          timeEstimateMinutes: dto.timeEstimateMinutes ?? null,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          parentId: parent?.id ?? null,
          sprintId: sprint?.id ?? null,
          releaseId: release?.id ?? null,
          milestoneId: milestone?.id ?? null,
          acceptanceCriteria: dto.acceptanceCriteria?.trim() || null,
          position: (last._max.position ?? 0) + POSITION_STEP,
          ...this.support.lifecycle(status.category, { startedAt: null, completedAt: null }),
          assignees: { create: assigneeIds.map((userId) => ({ userId })) },
          labels: { create: labels.map((l) => ({ labelId: l.id })) },
          watchers: { create: [...new Set([m.userId, ...assigneeIds])].map((userId) => ({ userId })) },
          customValues: {
            create: [...custom.entries()]
              .filter(([, v]) => v.value !== null)
              .map(([fieldId, v]) => ({ fieldId, value: v.value as Prisma.InputJsonValue })),
          },
        },
      });
      await this.activity.record(tx, task.id, m.userId, [{ type: 'created' }]);
      if (sprint) await this.support.trackSprintChange(tx, task, null, sprint);
      return task;
    });

    const key = taskKey(project.key, created.number);
    const base = { workspaceId: m.workspaceId, projectId: project.id, taskId: created.id, taskKey: key, actorId: m.userId };
    events.push({ name: TaskEvents.created, payload: base });
    if (created.sprintId) events.push({ name: TaskEvents.updated, payload: { ...base, fields: ['sprint'], sprintIds: [created.sprintId] } });
    if (dto.assigneeIds?.length) events.push({ name: TaskEvents.assigned, payload: { ...base, assigneeIds: [...new Set(dto.assigneeIds)] } });
    await this.updates.pushMentions(events, base, project, m.workspaceId, extractMentionedUserIds(dto.description), 'description');
    if (!opts.silent) this.emit(events);
    return this.detail(m, created.id);
  }

  // ---------- read ----------
  async get(m: Membership, ref: string): Promise<TaskDetailDto> {
    const { task } = await this.access.load(m, ref);
    return this.detail(m, task.id);
  }

  async detail(m: Membership, taskId: string): Promise<TaskDetailDto> {
    const row = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        ...summaryInclude,
        parent: { include: refInclude },
        children: { where: { archivedAt: null }, include: summaryInclude, orderBy: { number: 'asc' } },
        relationsFrom: { include: { to: { include: refInclude } } },
        relationsTo: { include: { from: { include: refInclude } } },
        checklists: { include: { items: { orderBy: { position: 'asc' } } }, orderBy: { position: 'asc' } },
        attachments: { orderBy: { createdAt: 'asc' } },
        customValues: { include: { field: true } },
        watchers: { include: { user: { select: { id: true, name: true } } } },
      },
    });
    const pm = await this.projects.projectRole(row.projectId, m.userId);
    const canEdit = this.projects.canWrite(m, pm);

    // Hide related tasks that live in projects the caller cannot see.
    const visible = new Set(
      (await this.prisma.project.findMany({
        where: { workspaceId: m.workspaceId, ...this.projects.visibleProjects(m) },
        select: { id: true },
      })).map((p) => p.id),
    );
    const relations = [
      ...row.relationsFrom.map((r) => ({
        id: r.id, row: r.to,
        kind: ({ BLOCKS: 'blocks', RELATES: 'relates_to', DUPLICATES: 'duplicates' } as const)[r.type],
      })),
      ...row.relationsTo.map((r) => ({
        id: r.id, row: r.from,
        kind: ({ BLOCKS: 'blocked_by', RELATES: 'relates_to', DUPLICATES: 'duplicated_by' } as const)[r.type],
      })),
    ].filter((r) => visible.has(r.row.projectId)).map((r) => ({ id: r.id, kind: r.kind, task: toRefDto(r.row) }));

    const [summary] = await this.query.toDtos([row]);
    const subtasks = await this.query.toDtos(row.children);
    return {
      ...summary,
      description: row.description,
      acceptanceCriteria: row.acceptanceCriteria,
      parent: row.parent ? toRefDto(row.parent) : null,
      subtasks,
      relations,
      checklists: row.checklists.map((c) => ({
        id: c.id, title: c.title, position: c.position,
        items: c.items.map((i) => ({ id: i.id, text: i.text, done: i.done, position: i.position })),
      })),
      attachments: row.attachments.map((a) => ({
        id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size, uploaderId: a.uploaderId, createdAt: a.createdAt,
      })),
      customFields: row.customValues
        .map((v) => ({ fieldId: v.fieldId, name: v.field.name, type: v.field.type, value: v.value as string | number | boolean | null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      watchers: row.watchers.map((w) => ({ userId: w.userId, name: w.user.name })),
      isWatching: row.watchers.some((w) => w.userId === m.userId),
      canEdit,
    };
  }

  // ---------- update ----------

  async update(m: Membership, ref: string, dto: UpdateTaskDto): Promise<TaskDetailDto> {
    const { task, project } = await this.access.load(m, ref, { write: true });
    const events: TaskEvent[] = [];
    await this.prisma.$transaction(async (tx) => {
      await this.updates.applyUpdate(tx, m, project, task.id, dto, events);
    });
    this.emit(events);
    return this.detail(m, task.id);
  }

  /**
   * Moves a task to another status on behalf of an integration (GitHub automations). `actorId` is
   * who the history credits, if a person is known; `eventActorId` is who realtime and
   * notification listeners are told caused it. Does nothing when the task is already there.
   */
  async setStatusFromIntegration(taskId: string, statusId: string, actorId: string | null, eventActorId: string): Promise<boolean> {
    const events: TaskEvent[] = [];
    const changed = await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId }, include: { status: true, project: true } });
      if (!task || task.statusId === statusId) return false;
      const status = await this.support.resolveStatus(tx, task.projectId, statusId);
      await this.support.lockProject(tx, task.projectId);
      const last = await tx.task.aggregate({ where: { projectId: task.projectId }, _max: { position: true } });
      await tx.task.update({
        where: { id: taskId },
        data: { statusId: status.id, ...this.support.lifecycle(status.category, task), position: (last._max.position ?? 0) + POSITION_STEP },
      });
      await this.activity.record(tx, taskId, actorId, [{ type: 'updated', field: 'status', from: task.status.name, to: status.name }]);
      const base = {
        workspaceId: task.project.workspaceId, projectId: task.projectId, taskId, taskKey: taskKey(task.project.key, task.number), actorId: eventActorId,
      };
      events.push({ name: TaskEvents.statusChanged, payload: { ...base, from: task.status.name, to: status.name } });
      events.push({ name: TaskEvents.updated, payload: { ...base, fields: ['status'], ...(task.sprintId ? { sprintIds: [task.sprintId] } : {}) } });
      return true;
    });
    this.emit(events);
    return changed;
  }

  /** Applies `dto` to one task, writing activity rows and collecting events. Runs inside a transaction. */
  // ---------- archive / delete ----------

  async setArchived(m: Membership, ref: string, archived: boolean): Promise<TaskDetailDto> {
    const { task, project } = await this.access.load(m, ref, { write: true });
    if (archived !== (task.archivedAt !== null)) {
      await this.prisma.$transaction(async (tx) => {
        await tx.task.update({ where: { id: task.id }, data: { archivedAt: archived ? new Date() : null } });
        await this.activity.record(tx, task.id, m.userId, [{ type: archived ? 'archived' : 'restored' }]);
      });
      this.events.emit(TaskEvents.updated, {
        workspaceId: m.workspaceId, projectId: task.projectId, taskId: task.id, taskKey: taskKey(project.key, task.number),
        actorId: m.userId, fields: ['archived'], ...(task.sprintId ? { sprintIds: [task.sprintId] } : {}),
      });
    }
    return this.detail(m, task.id);
  }

  async remove(m: Membership, ref: string) {
    const { task, manage, project } = await this.access.load(m, ref, { write: true });
    if (!manage && task.reporterId !== m.userId) {
      throw new ForbiddenException('Only the reporter or a project admin can delete a task');
    }
    const files = await this.prisma.attachment.findMany({ where: { taskId: task.id }, select: { storageKey: true } });
    await this.prisma.task.delete({ where: { id: task.id } });
    await Promise.all(files.map((f) => this.storage.delete(f.storageKey).catch(() => undefined)));
    this.events.emit(TaskEvents.deleted, {
      workspaceId: m.workspaceId, projectId: project.id, taskId: task.id,
      taskKey: taskKey(project.key, task.number), actorId: m.userId,
      ...(task.sprintId ? { sprintIds: [task.sprintId] } : {}),
    });
  }

  // ---------- bulk ----------

  async bulkUpdate(m: Membership, taskIds: string[], changes: BulkChangesDto): Promise<BulkResultDto> {
    const ids = [...new Set(taskIds)];
    const rows = await this.prisma.task.findMany({
      where: { id: { in: ids }, project: { workspaceId: m.workspaceId } },
      include: { labels: true },
    });
    if (rows.length !== ids.length) throw new NotFoundException('Some tasks were not found');

    const projects = new Map<string, Project>();
    for (const projectId of new Set(rows.map((r) => r.projectId))) {
      projects.set(projectId, (await this.projects.load(m, projectId, { write: true })).project);
    }
    if (changes.statusId && projects.size > 1) {
      throw new BadRequestException('Status can only be changed in bulk for tasks of a single project');
    }

    const events: TaskEvent[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const project = projects.get(row.projectId)!;
        const dto: UpdateTaskDto = {};
        if (changes.statusId !== undefined) dto.statusId = changes.statusId;
        if (changes.priority !== undefined) dto.priority = changes.priority;
        if (changes.assigneeIds !== undefined) dto.assigneeIds = changes.assigneeIds;
        if (changes.dueDate !== undefined) dto.dueDate = changes.dueDate;
        if (changes.sprintId !== undefined) dto.sprintId = changes.sprintId;
        if (changes.releaseId !== undefined) dto.releaseId = changes.releaseId;
        if (changes.milestoneId !== undefined) dto.milestoneId = changes.milestoneId;
        if (changes.addLabelIds || changes.removeLabelIds) {
          const labels = new Set(row.labels.map((l) => l.labelId));
          changes.addLabelIds?.forEach((id) => labels.add(id));
          changes.removeLabelIds?.forEach((id) => labels.delete(id));
          dto.labelIds = [...labels];
        }
        await this.updates.applyUpdate(tx, m, project, row.id, dto, events);
        if (changes.archived !== undefined && changes.archived !== (row.archivedAt !== null)) {
          await tx.task.update({ where: { id: row.id }, data: { archivedAt: changes.archived ? new Date() : null } });
          await this.activity.record(tx, row.id, m.userId, [{ type: changes.archived ? 'archived' : 'restored' }]);
        }
      }
    });
    this.emit(events);
    return { updated: rows.length };
  }
}
