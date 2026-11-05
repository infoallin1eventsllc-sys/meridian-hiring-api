import type { Deps } from './context.js';

type FileDeps = Pick<Deps, 'sql' | 'storage'>;

/** Removes files from storage and clears them from the pending queue. Never throws. */
export async function removeFiles({ sql, storage }: FileDeps, paths: string[]) {
  if (paths.length === 0) return;
  try {
    await storage.remove(paths);
    await sql`delete from hire.pending_file_deletions where storage_path in ${sql(paths)}`;
  } catch (err) {
    console.error('Storage cleanup failed; will retry', err);
    await sql`
      update hire.pending_file_deletions set attempts = attempts + 1
      where storage_path in ${sql(paths)}`.catch(() => {});
  }
}

export async function drainPendingFiles(deps: FileDeps) {
  const rows = await deps.sql<{ storage_path: string }[]>`
    select storage_path from hire.pending_file_deletions order by created_at limit 500`;
  await removeFiles(
    deps,
    rows.map((r) => r.storage_path),
  );
  return rows.length;
}

/** Deletes sandboxes past their expiry, along with every file they uploaded. */
export async function deleteExpiredSandboxes(deps: FileDeps) {
  const { sql } = deps;
  const removed = await sql.begin(async (tx) => {
    const expired = await tx<{ id: string }[]>`
      select id from hire.companies
      where plan = 'sandbox' and expires_at <= now()
      order by expires_at limit 200
      for update skip locked`;
    if (expired.length === 0) return 0;
    const ids = expired.map((e) => e.id);
    await tx`
      insert into hire.pending_file_deletions (storage_path, company_id)
      select storage_path, company_id from hire.resumes where company_id in ${tx(ids)}
      on conflict do nothing`;
    await tx`delete from hire.companies where id in ${tx(ids)}`;
    return ids.length;
  });
  return removed;
}

export async function runMaintenance(deps: FileDeps) {
  const sandboxesDeleted = await deleteExpiredSandboxes(deps);
  // One pass removes the files of sandboxes deleted just now and retries any earlier failures.
  const filesQueued = await drainPendingFiles(deps);
  await deps.sql`delete from hire.rate_limit_counters where window_start < now() - interval '1 day'`;
  return { sandboxes_deleted: sandboxesDeleted, files_processed: filesQueued };
}
