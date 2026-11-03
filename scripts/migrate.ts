// npm run db:migrate  (uses DATABASE_URL; for Supabase use the direct or session connection, port 5432)
import { fileURLToPath } from 'node:url';
import { createSql } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const sql = createSql(url);
await migrate(sql, fileURLToPath(new URL('../db/migrations', import.meta.url)), console.log);
console.log('Database is up to date.');
await sql.end();
