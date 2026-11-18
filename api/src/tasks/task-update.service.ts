import { BadRequestException, Injectable } from '@nestjs/common';
import type { Membership, Prisma, Project } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService, type ActivityEntry } from './activity.service.js';
import { POSITION_STEP } from './ranking.js';
import type { UpdateTaskDto } from './dto/task.dto.js';
import { hierarchyError, validParentTypes } from './hierarchy.js';
import { TaskEvents, type TaskEvent } from './events.js';
import { extractMentionedUserIds } from './mentions.js';
import { TaskSupportService } from './task-support.service.js';
import { taskKey } from './task-ref.js';

type Tx = Prisma.TransactionClient;

/**
 * Applies a change to one task inside a transaction: validation, side effects (sprint and status
 * rules, children, custom fields), activity entries and the events to emit afterwards. Shared by
 * single and bulk updates, ranking and integrations.
 */
@Injectable()
export class TaskUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly support: TaskSupportService,
    private readonly activity: ActivityService,
  ) {}

  async pushMentions(
    events: TaskEvent[],
    base: { workspaceId: string; projectId: string; taskId: string; taskKey: string; actorId: string },
    project: Project,
    workspaceId: string,
    wanted: string[],
    source: 'comment' | 'description',
    commentId?: string,
  ) {
    const mentionable = await this.support.visibleUserIds(
      this.prisma, workspaceId, project, wanted.filter((id) => id !== base.actorId),
    );
    if (mentionable.length) {
      events.push({ name: TaskEvents.mentioned, payload: { ...base, mentionedUserIds: mentionable, source, commentId } });
    }
  }

  async applyUpdate(
    tx: Tx, m: Membership, project: Project, taskId: string, dto: UpdateTaskDto, events: TaskEvent[],
  ): Promise<void> {
    const task = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        status: true, parent: true, children: { select: { type: true } },
        assignees: true, labels: { include: { label: true } }, sprint: true,
      },
    });
    const entries: ActivityEntry[] = [];
    const data: Prisma.TaskUpdateInput = {};
    const base = { workspaceId: m.workspaceId, projectId: project.id, taskId, taskKey: taskKey(project.key, task.number), actorId: m.userId };

    if (dto.title !== undefined && dto.title.trim() !== task.title) {
      data.title = dto.title.trim();
      entries.push({ type: 'updated', field: 'title', from: task.title, to: data.title });
    }

    if (dto.description !== undefined) {
      const next = dto.description?.trim() || null;
      if (next !== task.description) {
        data.description = next;
        entries.push({ type: 'updated', field: 'description' });
        const added = extractMentionedUserIds(next).filter((id) => !extractMentionedUserIds(task.description).includes(id));
        await this.pushMentions(events, base, project, m.workspaceId, added, 'description');
      }
    }

    // type and parent are validated together
    const newType = dto.type ?? task.type;
    let parentRow: { id: string; type: typeof task.type } | null = task.parent ? { id: task.parent.id, type: task.parent.type } : null;
    if (dto.parentId !== undefined) {
      if (dto.parentId === task.id) throw new BadRequestException('A task cannot be its own parent');
      parentRow = dto.parentId ? await this.support.resolveParent(tx, project.id, dto.parentId) : null;
    }
    if (newType !== task.type || dto.parentId !== undefined) {
      const problem = hierarchyError(newType, parentRow?.type ?? null);
      if (problem) throw new BadRequestException(problem);
      const allowedParents = (t: typeof newType) => validParentTypes(t);
      for (const child of task.children) {
        if (!allowedParents(child.type)?.includes(newType)) {
          throw new BadRequestException(`A ${newType.toLowerCase()} cannot contain ${child.type.toLowerCase()}s; move or delete its children first`);
        }
      }
    }
    if (newType !== task.type) {
      data.type = newType;
      entries.push({ type: 'updated', field: 'type', from: task.type, to: newType });
    }
    if (dto.parentId !== undefined && (parentRow?.id ?? null) !== task.parentId) {
      data.parent = parentRow ? { connect: { id: parentRow.id } } : { disconnect: true };
      entries.push({ type: 'updated', field: 'parent', from: task.parentId, to: parentRow?.id ?? null });
    }

    if (dto.statusId !== undefined && dto.statusId !== task.statusId) {
      const status = await this.support.resolveStatus(tx, project.id, dto.statusId);
      data.status = { connect: { id: status.id } };
      Object.assign(data, this.support.lifecycle(status.category, task));
      // A card changed through a form (not dragged) joins the bottom of its new column.
      await this.support.lockProject(tx, project.id);
      const last = await tx.task.aggregate({ where: { projectId: project.id }, _max: { position: true } });
      data.position = (last._max.position ?? 0) + POSITION_STEP;
      entries.push({ type: 'updated', field: 'status', from: task.status.name, to: status.name });
      events.push({ name: TaskEvents.statusChanged, payload: { ...base, from: task.status.name, to: status.name } });
    }

    if (dto.priority !== undefined && dto.priority !== task.priority) {
      data.priority = dto.priority;
      entries.push({ type: 'updated', field: 'priority', from: task.priority, to: dto.priority });
    }
    if (dto.estimate !== undefined && dto.estimate !== task.estimate) {
      this.support.assertEstimate(project, dto.estimate);
      data.estimate = dto.estimate;
      entries.push({ type: 'updated', field: 'estimate', from: task.estimate, to: dto.estimate });
    }
    if (dto.timeEstimateMinutes !== undefined && dto.timeEstimateMinutes !== task.timeEstimateMinutes) {
      data.timeEstimateMinutes = dto.timeEstimateMinutes;
      entries.push({ type: 'updated', field: 'timeEstimate', from: task.timeEstimateMinutes, to: dto.timeEstimateMinutes });
    }
    if (dto.startDate !== undefined) {
      const next = dto.startDate ? new Date(dto.startDate) : null;
      if ((next?.getTime() ?? null) !== (task.startDate?.getTime() ?? null)) {
        data.startDate = next;
        entries.push({ type: 'updated', field: 'startDate', from: task.startDate?.toISOString() ?? null, to: next?.toISOString() ?? null });
      }
    }
    if (dto.dueDate !== undefined) {
      const next = dto.dueDate ? new Date(dto.dueDate) : null;
      if ((next?.getTime() ?? null) !== (task.dueDate?.getTime() ?? null)) {
        data.dueDate = next;
        entries.push({ type: 'updated', field: 'dueDate', from: task.dueDate?.toISOString() ?? null, to: next?.toISOString() ?? null });
      }
    }

    // ---- agile planning fields
    let sprintTouched = false;
    let nextSprint: Pick<import('../generated/prisma/client.js').Sprint, 'id' | 'name' | 'state'> | null | undefined;
    if (dto.sprintId !== undefined) {
      if (dto.sprintId === (task.sprintId ?? null)) nextSprint = undefined;
      else if (dto.sprintId === null) nextSprint = null;
      else nextSprint = await this.support.resolveSprint(tx, project.id, dto.sprintId);
    }
    // A task finished in a closed sprint that is reopened goes back to the backlog.
    if (nextSprint === undefined && task.sprint?.state === 'COMPLETED' && data.status && !(await this.isDone(tx, dto.statusId))) {
      nextSprint = null;
    }
    if (nextSprint !== undefined) {
      if (task.sprint?.state === 'COMPLETED' && task.status.category === 'DONE' && !(data.status && !(await this.isDone(tx, dto.statusId)))) {
        throw new BadRequestException('This task was finished in a closed sprint');
      }
      if (nextSprint && newType === 'EPIC') throw new BadRequestException('Epics cannot be planned into a sprint');
      if (nextSprint && task.archivedAt) throw new BadRequestException('Archived tasks cannot be planned into a sprint');
      const openFrom = task.sprint && task.sprint.state !== 'COMPLETED' ? task.sprint : null;
      await this.support.trackSprintChange(tx, task, openFrom, nextSprint);
      data.sprint = nextSprint ? { connect: { id: nextSprint.id } } : { disconnect: true };
      entries.push({ type: 'updated', field: 'sprint', from: task.sprint?.name ?? null, to: nextSprint?.name ?? null });
      sprintTouched = true;
    }
    if (dto.releaseId !== undefined && dto.releaseId !== (task.releaseId ?? null)) {
      const release = dto.releaseId ? await this.support.resolveRelease(tx, project.id, dto.releaseId) : null;
      const before = task.releaseId ? await tx.release.findUnique({ where: { id: task.releaseId } }) : null;
      data.release = release ? { connect: { id: release.id } } : { disconnect: true };
      entries.push({ type: 'updated', field: 'release', from: before?.name ?? null, to: release?.name ?? null });
    }
    if (dto.milestoneId !== undefined && dto.milestoneId !== (task.milestoneId ?? null)) {
      const milestone = dto.milestoneId ? await this.support.resolveMilestone(tx, project.id, dto.milestoneId) : null;
      const before = task.milestoneId ? await tx.milestone.findUnique({ where: { id: task.milestoneId } }) : null;
      data.milestone = milestone ? { connect: { id: milestone.id } } : { disconnect: true };
      entries.push({ type: 'updated', field: 'milestone', from: before?.name ?? null, to: milestone?.name ?? null });
    }
    if (dto.acceptanceCriteria !== undefined) {
      const next = dto.acceptanceCriteria?.trim() || null;
      if (next !== task.acceptanceCriteria) {
        data.acceptanceCriteria = next;
        entries.push({ type: 'updated', field: 'acceptanceCriteria' });
      }
    }

    if (dto.assigneeIds !== undefined) {
      const next = await this.support.assertAssignees(tx, m.workspaceId, project, dto.assigneeIds);
      const prev = task.assignees.map((a) => a.userId);
      const added = next.filter((id) => !prev.includes(id));
      const removed = prev.filter((id) => !next.includes(id));
      if (added.length || removed.length) {
        await tx.taskAssignee.deleteMany({ where: { taskId, userId: { in: removed } } });
        await tx.taskAssignee.createMany({ data: added.map((userId) => ({ taskId, userId })) });
        await tx.taskWatcher.createMany({ data: added.map((userId) => ({ taskId, userId })), skipDuplicates: true });
        entries.push({ type: 'updated', field: 'assignees', from: prev, to: next });
        if (added.length) events.push({ name: TaskEvents.assigned, payload: { ...base, assigneeIds: added } });
      }
    }

    if (dto.labelIds !== undefined) {
      const labels = await this.support.assertLabels(tx, project.id, dto.labelIds);
      const prev = new Set(task.labels.map((l) => l.labelId));
      const next = new Set(labels.map((l) => l.id));
      if (prev.size !== next.size || [...next].some((id) => !prev.has(id))) {
        await tx.taskLabel.deleteMany({ where: { taskId } });
        await tx.taskLabel.createMany({ data: labels.map((l) => ({ taskId, labelId: l.id })) });
        entries.push({
          type: 'updated', field: 'labels',
          from: task.labels.map((l) => l.label.name).sort(), to: labels.map((l) => l.name).sort(),
        });
      }
    }

    if (dto.customFields !== undefined) {
      const defs = await this.support.customFieldDefs(tx, project.id);
      const input = this.support.normalizeCustomInput(defs, dto.customFields);
      const existing = new Map((await tx.taskCustomValue.findMany({ where: { taskId } })).map((v) => [v.fieldId, v.value]));
      for (const [fieldId, { def, value }] of input) {
        const prev = existing.get(fieldId) ?? null;
        if (JSON.stringify(prev) === JSON.stringify(value)) continue;
        if (value === null) await tx.taskCustomValue.deleteMany({ where: { taskId, fieldId } });
        else {
          await tx.taskCustomValue.upsert({
            where: { taskId_fieldId: { taskId, fieldId } },
            create: { taskId, fieldId, value },
            update: { value },
          });
        }
        entries.push({ type: 'updated', field: `custom:${def.name}`, from: prev as Prisma.InputJsonValue | null, to: value });
      }
    }

    if (entries.length === 0) return;
    if (Object.keys(data).length) await tx.task.update({ where: { id: taskId }, data });
    else await tx.task.update({ where: { id: taskId }, data: { updatedAt: new Date() } });
    await this.activity.record(tx, taskId, m.userId, entries);
    const fields = entries.map((e) => e.field ?? e.type);
    // Sprints whose burndown may have changed: the old and new one, or the current one if progress changed.
    const sprintIds = new Set<string>();
    if (sprintTouched) {
      if (task.sprintId) sprintIds.add(task.sprintId);
      if (nextSprint) sprintIds.add(nextSprint.id);
    } else if (task.sprintId && fields.some((f) => f === 'status' || f === 'estimate')) {
      sprintIds.add(task.sprintId);
    }
    events.push({ name: TaskEvents.updated, payload: { ...base, fields, ...(sprintIds.size ? { sprintIds: [...sprintIds] } : {}) } });
  }

  private async isDone(tx: Tx, statusId: string | undefined): Promise<boolean> {
    if (!statusId) return false;
    return (await tx.projectStatus.findUnique({ where: { id: statusId } }))?.category === 'DONE';
  }

}
