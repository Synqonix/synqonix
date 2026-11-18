import { OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { StatusCategory, TaskPriority, TaskType } from '../../generated/prisma/enums.js';

const toBool = ({ value }: { value: unknown }) => value === 'true' || value === true;

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title: string;

  @IsOptional()
  @IsEnum(TaskType)
  type?: TaskType;

  /** Markdown, up to 50,000 characters. */
  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  description?: string;

  /** Defaults to the project's first "to do" status. */
  @IsOptional()
  @IsString()
  statusId?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  assigneeIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  labelIds?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  estimate?: number;

  /** Planned effort in minutes. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600_000)
  timeEstimateMinutes?: number;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  /** Plan the task into a (planned or active) sprint of this project. */
  @IsOptional()
  @IsString()
  sprintId?: string;

  /** Fix version. */
  @IsOptional()
  @IsString()
  releaseId?: string;

  @IsOptional()
  @IsString()
  milestoneId?: string;

  /** Markdown. */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  acceptanceCriteria?: string;

  /** Map of custom field id to value. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsEnum(TaskType)
  type?: TaskType;

  /** Pass `null` to clear. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(50_000)
  description?: string | null;

  @IsOptional()
  @IsString()
  statusId?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  /** Replaces the assignee list. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  assigneeIds?: string[];

  /** Replaces the label list. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  labelIds?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(1000)
  estimate?: number | null;

  /** Planned effort in minutes; `null` clears it. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(600_000)
  timeEstimateMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  startDate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  dueDate?: string | null;

  /** Pass `null` to detach from the parent. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  parentId?: string | null;

  /** Move to a sprint, or `null` for the backlog. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  sprintId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  releaseId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  milestoneId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20_000)
  acceptanceCriteria?: string | null;

  /** Map of custom field id to value; `null` clears a value. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class BulkChangesDto {
  @IsOptional()
  @IsString()
  statusId?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  /** Replaces the assignee list of every selected task. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  assigneeIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  addLabelIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  removeLabelIds?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  /** Sprint to move every selected task into, or `null` for the backlog. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  sprintId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  releaseId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  milestoneId?: string | null;
}

export class BulkUpdateTasksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  taskIds: string[];

  @ValidateNested()
  @Type(() => BulkChangesDto)
  changes: BulkChangesDto;
}

export class MoveTaskDto {
  /** Destination project in the same workspace. */
  @IsString()
  projectId: string;
}

export class ListTasksQueryDto {
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() statusId?: string;
  @IsOptional() @IsEnum(StatusCategory) statusCategory?: StatusCategory;
  @IsOptional() @IsEnum(TaskType) type?: TaskType;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  /** `me`, `none` (unassigned) or a user id. */
  @IsOptional() @IsString() assignee?: string;
  @IsOptional() @IsString() reporter?: string;
  @IsOptional() @IsString() labelId?: string;
  /** `none` for top-level tasks, or a parent task id. */
  @IsOptional() @IsString() parent?: string;
  /** Matches the title, or the key / number (`SYN-12`, `12`). */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsDateString() dueBefore?: string;
  @IsOptional() @IsDateString() dueAfter?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() includeArchived?: boolean;
  /** `none` (backlog), `active` (the running sprint) or a sprint id. */
  @IsOptional() @IsString() sprintId?: string;
  /** `none` or a release id. */
  @IsOptional() @IsString() releaseId?: string;
  /** `none` or a milestone id. */
  @IsOptional() @IsString() milestoneId?: string;
  /** Hide sub-tasks (boards do this by default). */
  @IsOptional() @Transform(toBool) @IsBoolean() excludeSubtasks?: boolean;
  /** Apply a saved view; explicit parameters override its filters. */
  @IsOptional() @IsString() view?: string;
  @IsOptional() @IsEnum(['createdAt', 'updatedAt', 'dueDate', 'startDate', 'priority', 'number', 'position', 'title'])
  sort?: 'createdAt' | 'updatedAt' | 'dueDate' | 'startDate' | 'priority' | 'number' | 'position' | 'title';
  @IsOptional() @IsEnum(['asc', 'desc']) order?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  /** Deprecated: use `cursor`. Offsets skip or repeat rows while tasks change, and get slow on large lists. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  /** `nextCursor` from the previous page (same filters, sort and order). Takes precedence over `offset`. */
  @IsOptional() @IsString() @MaxLength(1000) cursor?: string;
}

export class RankTaskDto {
  /** Column to drop the card into. Defaults to the card's current status. */
  @IsOptional()
  @IsString()
  statusId?: string;

  /** Place the card directly above this card (which must be in the target column). */
  @IsOptional()
  @IsString()
  beforeId?: string;

  /** Place the card directly below this card (which must be in the target column). */
  @IsOptional()
  @IsString()
  afterId?: string;
}

export class RecentTasksQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

export class BoardQueryDto extends OmitType(ListTasksQueryDto, ['projectId', 'statusId', 'statusCategory', 'sort', 'order', 'offset', 'cursor'] as const) {}
