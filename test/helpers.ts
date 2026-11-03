import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Deps, Plan, Scope } from '../src/context.js';
import { generateApiKey } from '../src/crypto.js';
import { createSql, type Sql } from '../src/db.js';
import { MemoryStorage } from '../src/storage.js';

export const JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-hs256';
export const CRON_SECRET = 'test-cron-secret';

let shared: Sql | undefined;
export function testSql(): Sql {
  shared ??= createSql(inject('databaseUrl'));
  return shared;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: inject('databaseUrl'),
    publicBaseUrl: 'http://localhost:8787',
    encryptionKey: randomBytes(32),
    cronSecret: CRON_SECRET,
    supabaseJwtSecret: JWT_SECRET,
    storageBucket: 'resumes',
    allowPrivateWebhooks: true,
    ...overrides,
  };
}

/** The app wired to the test database, with in-memory storage and awaitable background work. */
export function makeApp(overrides: Partial<Config> = {}) {
  const pending: Promise<unknown>[] = [];
  const storage = new MemoryStorage();
  const deps: Deps = {
    sql: testSql(),
    config: testConfig(overrides),
    storage,
    background: (task) => void pending.push(task),
  };
  const app = createApp(deps);
  return {
    app,
    deps,
    storage,
    /** Waits for background work (webhook sends) started by earlier requests. */
    async settle() {
      while (pending.length) await pending.shift();
    },
    request: (method: string, path: string, opts: RequestOptions = {}) => call(app, method, path, opts),
  };
}

export interface RequestOptions {
  key?: string;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
}

export async function call(app: ReturnType<typeof createApp>, method: string, path: string, opts: RequestOptions = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

/** A fresh company with one API key. */
export async function createCompany(opts: { plan?: Plan; scopes?: Scope[]; name?: string; expiresAt?: Date } = {}) {
  const sql = testSql();
  const [company] = await sql`
    insert into hire.companies (name, plan, expires_at)
    values (${opts.name ?? `Test Co ${randomUUID().slice(0, 8)}`}, ${opts.plan ?? 'team'}, ${opts.expiresAt ?? null})
    returning id`;
  const key = await addKey(company!.id, opts.scopes ?? ['read', 'write', 'admin']);
  return { companyId: company!.id as string, key: key.key, keyId: key.id };
}

export async function addKey(companyId: string, scopes: Scope[]) {
  const generated = generateApiKey();
  const [row] = await testSql()`
    insert into hire.api_keys (company_id, name, prefix, key_hash, scopes)
    values (${companyId}, 'test key', ${generated.prefix}, ${generated.hash}, ${scopes})
    returning id`;
  return { key: generated.key, id: row!.id as string };
}

export async function loginToken(userId: string, opts: { expiresIn?: string; secret?: string } = {}) {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(opts.secret ?? JWT_SECRET));
}

export const candidateInput = (overrides: Record<string, unknown> = {}) => ({
  first_name: 'Jordan',
  last_name: 'Avery',
  email: `jordan.${randomUUID().slice(0, 8)}@example.com`,
  ...overrides,
});

/** Posts a job and returns its id. */
export async function postJob(t: ReturnType<typeof makeApp>, key: string, body: Record<string, unknown> = {}) {
  const res = await t.request('POST', '/v1/jobs', { key, body: { title: 'Backend Engineer', ...body } });
  if (res.status !== 201) throw new Error(`postJob failed: ${res.status} ${res.text}`);
  return res.body.id as string;
}

export async function apply(t: ReturnType<typeof makeApp>, key: string, jobId: string, candidate = candidateInput()) {
  const res = await t.request('POST', '/v1/applications', { key, body: { job_id: jobId, candidate } });
  if (res.status !== 201) throw new Error(`apply failed: ${res.status} ${res.text}`);
  return res.body;
}
