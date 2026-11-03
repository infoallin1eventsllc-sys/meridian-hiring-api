// npm run dev:local: everything on this machine, no accounts needed.
// Starts a private Postgres in .local/pgdata, applies migrations, then runs the
// API and board at http://localhost:8787. Résumés are kept in memory.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = fileURLToPath(new URL('../.local/pgdata', import.meta.url));
const port = 54329;
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user: 'postgres',
  password: 'postgres',
  persistent: true,
  onLog: () => {},
});
if (!existsSync(dataDir)) await pg.initialise();
await pg.start();

process.env.DATABASE_URL ??= `postgres://postgres:postgres@localhost:${port}/postgres`;
// Keep the local encryption key between runs so saved webhook secrets stay readable.
const keyFile = fileURLToPath(new URL('../.local/encryption-key', import.meta.url));
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
process.env.APP_ENCRYPTION_KEY ??= readFileSync(keyFile, 'utf8').trim();
process.env.WEBHOOK_ALLOW_PRIVATE ??= '1';
process.env.CRON_SECRET ??= 'local-cron-secret';

const { createSql } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const sql = createSql(process.env.DATABASE_URL);
await migrate(sql, fileURLToPath(new URL('../db/migrations', import.meta.url)), console.log);
await sql.end();

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await import('../src/server.js');
