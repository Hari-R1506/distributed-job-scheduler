import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { LIMITS } from '@djs/core';
import { AppError } from './errors.js';

/**
 * Keyset (cursor) pagination on `(created_at, id)`.
 *
 * Offset pagination on this data is not merely slow, it is INCORRECT. `jobs`
 * takes thousands of inserts a minute; between a user's request for page 1 and
 * page 2, rows shift, so `OFFSET 50` skips records the user never saw and
 * repeats ones they did. Deep offsets also make Postgres scan and discard
 * everything before the window.
 *
 * A keyset cursor encodes the last row's sort key and becomes
 * `WHERE (created_at, id) < ($c, $i)` — O(log n) at any depth and stable under
 * concurrent inserts.
 *
 * The trade: no "jump to page 7". Acceptable — nobody jumps to page 7 of a job
 * list, they filter. See ARCHITECTURE.md §29.9.
 */
export interface Cursor {
  /** Sort key value of the last row on the previous page. */
  v: string;
  /** Tiebreaker id, so rows sharing a timestamp still have a total order. */
  i: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.v !== 'string' || typeof parsed.i !== 'string') throw new Error('shape');
    return parsed;
  } catch {
    // A malformed cursor is a client bug, not a server one. Failing loudly
    // beats silently restarting from page 1, which looks like data loss.
    throw AppError.badRequest('Invalid pagination cursor', [
      { field: 'cursor', issue: 'not a valid cursor produced by this API' },
    ]);
  }
}

export class PaginationQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: LIMITS.PAGE_SIZE_MAX, default: LIMITS.PAGE_SIZE_DEFAULT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITS.PAGE_SIZE_MAX)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous response.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class PageInfo {
  @ApiProperty({ nullable: true }) next_cursor!: string | null;
  @ApiProperty() has_more!: boolean;
  @ApiProperty() limit!: number;
}

export class Page<T> {
  data!: T[];
  page!: PageInfo;
}

/**
 * Fetches `limit + 1` rows to learn whether another page exists without a
 * second COUNT query — a count over a filtered job list is exactly the kind of
 * scan this pagination scheme exists to avoid.
 */
export async function paginate<TRow, TOut>(
  query: PaginationQuery,
  fetch: (take: number, cursor: Cursor | undefined) => Promise<TRow[]>,
  key: (row: TRow) => Cursor,
  map: (row: TRow) => TOut,
): Promise<Page<TOut>> {
  const limit = query.limit ?? LIMITS.PAGE_SIZE_DEFAULT;
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

  const rows = await fetch(limit + 1, cursor);
  const hasMore = rows.length > limit;
  const window = hasMore ? rows.slice(0, limit) : rows;
  const last = window[window.length - 1];

  return {
    data: window.map(map),
    page: {
      next_cursor: hasMore && last ? encodeCursor(key(last)) : null,
      has_more: hasMore,
      limit,
    },
  };
}

/**
 * Prisma `where` fragment for "strictly after this cursor", descending.
 *
 * Expressed as an OR rather than a row-value comparison because Prisma has no
 * tuple comparison. It compiles to the same index range scan.
 */
export function cursorWhere(
  cursor: Cursor | undefined,
  field: 'createdAt' | 'runAt' | 'finishedAt' | 'deadLetteredAt',
): Record<string, unknown> {
  if (!cursor) return {};
  const value = new Date(cursor.v);
  return {
    OR: [{ [field]: { lt: value } }, { [field]: value, id: { lt: cursor.i } }],
  };
}
