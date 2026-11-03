import { ApiError } from './errors.js';

// Lists are newest first and paged with an opaque cursor built from the last
// row's (created_at, id). Unlike page numbers, cursors don't skip or repeat
// rows when new records arrive between requests.

export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(row: { created_at: Date; id: string | number }): string {
  return Buffer.from(JSON.stringify([row.created_at.toISOString(), String(row.id)])).toString('base64url');
}

export function decodeCursor(value: string | undefined, idKind: 'uuid' | 'int' = 'uuid'): Cursor | undefined {
  if (!value) return undefined;
  try {
    const [ts, id] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as [string, string];
    const createdAt = new Date(ts);
    const idOk =
      idKind === 'uuid'
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        : /^\d{1,15}$/.test(id);
    if (Number.isNaN(createdAt.getTime()) || typeof id !== 'string' || !idOk) throw new Error();
    return { createdAt, id };
  } catch {
    throw new ApiError('validation_failed', 'The cursor is not valid. Use next_cursor from a previous page.', {
      errors: [{ path: 'query.cursor', message: 'Invalid cursor' }],
    });
  }
}

/** Fetch limit + 1 rows, then call this to trim and work out the next cursor. */
export function page<T extends Record<string, any>>(rows: readonly T[], limit: number) {
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data,
    next_cursor: hasMore && last ? encodeCursor(last as unknown as { created_at: Date; id: string }) : null,
  };
}
