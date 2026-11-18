/** Shapes the task endpoints return (inputs live in task.dto.ts). */
import { SprintState, StatusCategory, TaskPriority, TaskType } from '../../generated/prisma/enums.js';

export class BoardStatusDto {
  id: string;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
  /** Soft limit: the board warns when a column holds more tasks than this. */
  wipLimit: number | null;
}

export class BoardColumnDto {
  status: BoardStatusDto;
  /** Matching tasks in this column, ignoring the per-column limit. */
  total: number;
  /** Ordered by rank; at most `limit` tasks. */
  tasks: TaskDto[];
  hasMore: boolean;
}

export class BoardDto {
  projectId: string;
  columns: BoardColumnDto[];
  /** Epics of the project, for epic swimlanes. */
  epics: TaskRefDto[];
}

export class TaskUserDto {
  userId: string;
  name: string;
}

export class TaskStatusDto {
  id: string;
  name: string;
  category: StatusCategory;
  color: string;
}

export class TaskLabelDto {
  id: string;
  name: string;
  color: string;
}

export class SprintRefDto {
  id: string;
  name: string;
  state: SprintState;
}

export class NamedRefDto {
  id: string;
  name: string;
}

export class TaskDto {
  id: string;
  /** Human key, e.g. `SYN-12`. */
  key: string;
  number: number;
  projectId: string;
  projectKey: string;
  title: string;
  type: TaskType;
  status: TaskStatusDto;
  priority: TaskPriority;
  assignees: TaskUserDto[];
  labels: TaskLabelDto[];
  reporterId: string | null;
  sprint: SprintRefDto | null;
  release: NamedRefDto | null;
  milestone: NamedRefDto | null;
  estimate: number | null;
  /** Planned effort in minutes. */
  timeEstimateMinutes: number | null;
  /** Minutes logged so far (finished entries and running timers up to now). */
  timeSpentMinutes: number;
  startDate: Date | null;
  dueDate: Date | null;
  parentId: string | null;
  position: number;
  archived: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  subtaskCount: number;
  subtaskDoneCount: number;
  commentCount: number;
}

export class TaskListDto {
  items: TaskDto[];
  total: number;
  /** Pass as `cursor` to get the next page; `null` on the last page. */
  nextCursor: string | null;
}

export class TaskRefDto {
  id: string;
  key: string;
  title: string;
  type: TaskType;
  status: TaskStatusDto;
}

export class TaskRelationDto {
  id: string;
  /** `blocks`, `blocked_by`, `relates_to`, `duplicates` or `duplicated_by`. */
  kind: string;
  task: TaskRefDto;
}

export class ChecklistItemDto {
  id: string;
  text: string;
  done: boolean;
  position: number;
}

export class ChecklistDto {
  id: string;
  title: string;
  position: number;
  items: ChecklistItemDto[];
}

export class AttachmentDto {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  uploaderId: string | null;
  createdAt: Date;
}

export class TaskCustomValueDto {
  fieldId: string;
  name: string;
  type: string;
  value: string | number | boolean | null;
}

export class TaskDetailDto extends TaskDto {
  description: string | null;
  acceptanceCriteria: string | null;
  parent: TaskRefDto | null;
  subtasks: TaskDto[];
  relations: TaskRelationDto[];
  checklists: ChecklistDto[];
  attachments: AttachmentDto[];
  customFields: TaskCustomValueDto[];
  watchers: TaskUserDto[];
  isWatching: boolean;
  /** Whether the caller may edit this task. */
  canEdit: boolean;
}

export class BulkResultDto {
  updated: number;
}

export class ActivityDto {
  id: string;
  actorId: string | null;
  type: string;
  field: string | null;
  from: unknown;
  to: unknown;
  createdAt: Date;
}
