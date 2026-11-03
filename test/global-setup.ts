// Starts a throwaway Postgres for the test run (unless DATABASE_URL points at
// one, as in CI), applies the migrations and hands the URL to the tests.
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';
import { createSql } from '../src/db.js';
import { migrate } from '../src/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  let url = process.env.DATABASE_URL;
  let pg: EmbeddedPostgres | undefined;
  let dataDir: string | undefined;
  if (!url) {
    const port = 55000 + Math.floor(Math.random() * 5000);
    dataDir = join(tmpdir(), `meridian-hire-test-${process.pid}`);
    pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    url = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }
  const sql = createSql(url);
  await migrate(sql, fileURLToPath(new URL('../db/migrations', import.meta.url)));
  await sql.end();
  project.provide('databaseUrl', url);

  return async () => {
    if (pg) await pg.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  };
}
