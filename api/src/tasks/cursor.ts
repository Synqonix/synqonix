import type { Prisma } from '../generated/prisma/client.js';
import { TaskPriority } from '../generated/prisma/enums.js';

export type TaskSort = 'createdAt' | 'updatedAt' | 'dueDate' | 'startDate' | 'priority' | 'number' | 'position' | 'title';
export type SortOrder = 'asc' | 'desc';

/** Where the next page starts: the last row's sort value and id (the tie-breaker). */
interface Cursor { s: TaskSort; o: SortOrder; v: string | number | null; id: string }

const DATE_FIELDS = new Set<TaskSort>(['createdAt', 'updatedAt', 'dueDate', 'startDate']);
/** Sorted with nulls last in both directions (see TasksService.list). */
const NULLABLE = new Set<TaskSort>(['dueDate', 'startDate']);
/** Postgres sorts an enum by declaration order; Prisma cannot compare enums with gt/lt, so use `in`. */
const PRIORITY_ORDER = Object.values(TaskPriority);

export class InvalidCursorError extends Error {}

type Row = { id: string } & Partial<Record<TaskSort, unknown>>;

/** Opaque token for the page after `row`. */
export function encodeCursor(sort: TaskSort, order: SortOrder, row: Row): string {
  const raw = row[sort];
  const v = raw instanceof Date ? raw.toISOString() : (raw as string | number | null | undefined) ?? null;
  return Buffer.from(JSON.stringify({ s: sort, o: order, v, id: row.id } satisfies Cursor)).toString('base64url');
}

/** Decodes a cursor and checks it belongs to the same sort; a cursor from another sort would skip rows. */
export function decodeCursor(token: string, sort: TaskSort, order: SortOrder): Cursor {
  let c: Cursor;
  try {
    c = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Cursor;
  } catch {
    throw new InvalidCursorError('Invalid cursor');
  }
  if (!c || typeof c.id !== 'string' || c.s !== sort || c.o !== order) throw new InvalidCursorError('Invalid cursor for this sort');
  if (c.v === null ? !NULLABLE.has(sort) : !valueOk(sort, c.v)) throw new InvalidCursorError('Invalid cursor');
  return c;
}

function valueOk(sort: TaskSort, v: unknown): boolean {
  if (DATE_FIELDS.has(sort)) return typeof v === 'string' && !Number.isNaN(Date.parse(v));
  if (sort === 'number' || sort === 'position') return typeof v === 'number' && Number.isFinite(v);
  if (sort === 'priority') return PRIORITY_ORDER.includes(v as TaskPriority);
  return typeof v === 'string';
}

/**
 * Rows strictly after the cursor in `ORDER BY <sort> <order> [NULLS LAST], id ASC` — the order
 * TasksService.list uses. Rows that change while someone pages move, but others are never repeated
 * or skipped the way they are with offsets.
 */
export function afterCursor(c: Cursor): Prisma.TaskWhereInput {
  const { s: sort, o: order, id } = c;
  const tie = { id: { gt: id } };
  if (c.v === null) return { AND: [{ [sort]: null }, tie] }; // already in the trailing nulls

  const value = DATE_FIELDS.has(sort) ? new Date(c.v as string) : c.v;
  let beyond: Prisma.TaskWhereInput;
  if (sort === 'priority') {
    const at = PRIORITY_ORDER.indexOf(value as TaskPriority);
    const later = order === 'asc' ? PRIORITY_ORDER.slice(at + 1) : PRIORITY_ORDER.slice(0, at);
    beyond = { priority: { in: later } };
  } else {
    beyond = { [sort]: { [order === 'asc' ? 'gt' : 'lt']: value } };
  }
  const or: Prisma.TaskWhereInput[] = [beyond, { AND: [{ [sort]: value }, tie] }];
  if (NULLABLE.has(sort)) or.push({ [sort]: null });
  return { OR: or };
}
