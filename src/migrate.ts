import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from './db.js';

/** Applies db/migrations/*.sql in name order, each once, each in its own transaction. */
export async function migrate(sql: Sql, dir: string, log: (msg: string) => void = () => {}) {
  await sql`create schema if not exists hire_meta`;
  await sql`
    create table if not exists hire_meta.migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
  const applied = new Set((await sql<{ name: string }[]>`select name from hire_meta.migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into hire_meta.migrations (name) values (${file})`;
    });
    log(`applied ${file}`);
  }
}
