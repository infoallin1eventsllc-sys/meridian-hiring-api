// npm run openapi > openapi.json  (prints the OpenAPI document without needing a database)
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createSql } from '../src/db.js';
import { MemoryStorage } from '../src/storage.js';

const sql = createSql('postgres://unused@localhost/unused'); // never connected: building the spec runs no queries
const app = createApp({
  sql,
  storage: new MemoryStorage(),
  background: () => {},
  config: {
    databaseUrl: '',
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'https://meridian-hire.vercel.app',
    encryptionKey: randomBytes(32),
    storageBucket: 'resumes',
    allowPrivateWebhooks: false,
  },
});
const res = await app.request(`${process.env.PUBLIC_BASE_URL ?? 'https://meridian-hire.vercel.app'}/openapi.json`);
console.log(JSON.stringify(await res.json(), null, 2));
await sql.end();
