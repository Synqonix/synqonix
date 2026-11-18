import { BadRequestException, Injectable } from '@nestjs/common';
import type { Membership, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { afterCursor, decodeCursor, encodeCursor, InvalidCursorError } from './cursor.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import type { BoardQueryDto, ListTasksQueryDto } from './dto/task.dto.js';
import type { BoardDto, TaskDto, TaskListDto } from './dto/task-response.dto.js';
import { timeSpentByTask } from './time-spent.js';
import { refInclude, summaryInclude, toRefDto, toTaskDto, type TaskRow } from './task-mapper.js';
import { ViewsService } from '../views/views.service.js';

/** The read side of tasks: filters, lists, the board and the DTOs other modules show. */
@Injectable()
export class TaskQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectAccessService,
    private readonly views: ViewsService,
  ) {}

  private async doneCounts(parentIds: string[]) {
    if (parentIds.length === 0) return new Map<string, number>();
    const rows = await this.prisma.task.groupBy({
      by: ['parentId'],
      where: { parentId: { in: parentIds }, archivedAt: null, status: { category: 'DONE' } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.parentId as string, r._count._all]));
  }

  async toDtos(rows: TaskRow[]): Promise<TaskDto[]> {
    const [done, spent] = await Promise.all([
      this.doneCounts(rows.filter((r) => r._count.children > 0).map((r) => r.id)),
      timeSpentByTask(this.prisma, rows.map((r) => r.id)),
    ]);
    return rows.map((r) => ({ ...toTaskDto(r, done.get(r.id) ?? 0), timeSpentMinutes: spent.get(r.id) ?? 0 }));
  }

  /** Filters shared by the list and the board. 404s when the project is hidden from the caller. */
  async buildWhere(m: Membership, q: ListTasksQueryDto): Promise<Prisma.TaskWhereInput> {
    if (q.projectId) await this.projects.load(m, q.projectId); // 404 for hidden/unknown projects

    const and: Prisma.TaskWhereInput[] = [];
    if (q.statusId) and.push({ statusId: q.statusId });
    if (q.statusCategory) and.push({ status: { category: q.statusCategory } });
    if (q.type) and.push({ type: q.type });
    if (q.excludeSubtasks) and.push({ type: { not: 'SUBTASK' } });
    if (q.sprintId === 'none') and.push({ sprintId: null });
    else if (q.sprintId === 'active') and.push({ sprint: { state: 'ACTIVE' } });
    else if (q.sprintId) and.push({ sprintId: q.sprintId });
    if (q.releaseId === 'none') and.push({ releaseId: null });
    else if (q.releaseId) and.push({ releaseId: q.releaseId });
    if (q.milestoneId === 'none') and.push({ milestoneId: null });
    else if (q.milestoneId) and.push({ milestoneId: q.milestoneId });
    if (q.priority) and.push({ priority: q.priority });
    if (q.reporter) and.push({ reporterId: q.reporter === 'me' ? m.userId : q.reporter });
    if (q.labelId) and.push({ labels: { some: { labelId: q.labelId } } });
    if (q.assignee === 'none') and.push({ assignees: { none: {} } });
    else if (q.assignee) and.push({ assignees: { some: { userId: q.assignee === 'me' ? m.userId : q.assignee } } });
    if (q.parent === 'none') and.push({ parentId: null });
    else if (q.parent) and.push({ parentId: q.parent });
    if (q.dueBefore) and.push({ dueDate: { lte: new Date(q.dueBefore) } });
    if (q.dueAfter) and.push({ dueDate: { gte: new Date(q.dueAfter) } });
    if (q.q?.trim()) {
      const text = q.q.trim();
      const key = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(text);
      and.push({
        OR: [
          { title: { contains: text, mode: 'insensitive' } },
          ...(key ? [{ number: Number(key[2]), project: { key: key[1].toUpperCase() } }] : []),
          ...(/^\d{1,9}$/.test(text) ? [{ number: Number(text) }] : []),
        ],
      });
    }

    return {
      project: {
        workspaceId: m.workspaceId,
        ...this.projects.visibleProjects(m),
        ...(q.projectId ? { id: q.projectId } : q.includeArchived ? {} : { archivedAt: null }),
      },
      ...(q.includeArchived ? {} : { archivedAt: null }),
      AND: and,
    };

  }

  async list(m: Membership, rawQuery: ListTasksQueryDto): Promise<TaskListDto> {
    const q = await this.views.resolveQuery(m, rawQuery);
    const where = await this.buildWhere(m, q);

    const order = q.order ?? (q.sort === 'createdAt' || q.sort === 'updatedAt' ? 'desc' : 'asc');
    const sort = q.sort ?? 'position';
    const orderBy: Prisma.TaskOrderByWithRelationInput[] = [
      sort === 'dueDate' || sort === 'startDate'
        ? { [sort]: { sort: order, nulls: 'last' } } as Prisma.TaskOrderByWithRelationInput
        : ({ [sort]: order } as Prisma.TaskOrderByWithRelationInput),
      { id: 'asc' },
    ];

    let after: Prisma.TaskWhereInput | undefined;
    try {
      after = q.cursor ? afterCursor(decodeCursor(q.cursor, sort, order)) : undefined;
    } catch (e) {
      if (e instanceof InvalidCursorError) throw new BadRequestException(e.message);
      throw e;
    }
    const limit = q.limit ?? 50;
    const [found, total] = await Promise.all([
      this.prisma.task.findMany({
        // One extra row tells whether another page follows.
        where: after ? { AND: [where, after] } : where, orderBy, include: summaryInclude, take: limit + 1, skip: after ? 0 : q.offset ?? 0,
      }),
      this.prisma.task.count({ where }),
    ]);
    const rows = found.slice(0, limit);
    const nextCursor = found.length > limit ? encodeCursor(sort, order, rows[rows.length - 1]) : null;
    return { items: await this.toDtos(rows), total, nextCursor };
  }


  /** Kanban data: one column per workflow status, each ranked by position. */
  async board(m: Membership, projectId: string, rawQuery: BoardQueryDto): Promise<BoardDto> {
    const { project } = await this.projects.load(m, projectId);
    const q = await this.views.resolveQuery(m, { ...rawQuery, projectId });
    const base = await this.buildWhere(m, { ...q, projectId, excludeSubtasks: q.excludeSubtasks ?? true });
    const limit = Math.min(q.limit ?? 50, 200);

    const statuses = await this.prisma.projectStatus.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
    const columns = await Promise.all(
      statuses.map(async (status) => {
        const where: Prisma.TaskWhereInput = { AND: [base, { statusId: status.id }] };
        const [rows, total] = await Promise.all([
          this.prisma.task.findMany({
            where, include: summaryInclude, take: limit, orderBy: [{ position: 'asc' }, { id: 'asc' }],
          }),
          this.prisma.task.count({ where }),
        ]);
        return {
          status: {
            id: status.id, name: status.name, category: status.category, color: status.color,
            position: status.position, wipLimit: status.wipLimit,
          },
          total,
          tasks: await this.toDtos(rows),
          hasMore: total > rows.length,
        };
      }),
    );
    const epics = await this.prisma.task.findMany({
      where: { projectId: project.id, type: 'EPIC', archivedAt: null },
      include: refInclude, orderBy: { number: 'asc' }, take: 100,
    });
    return { projectId, columns, epics: epics.map(toRefDto) };
  }

}
