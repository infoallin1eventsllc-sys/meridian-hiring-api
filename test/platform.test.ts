import { describe, expect, it } from 'vitest';
import { addKey, apply, createCompany, makeApp, postJob, testSql } from './helpers.js';

describe('rate limiting', () => {
  it('caps requests per key per minute and says when to come back', async () => {
    const t = makeApp();
    const s = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });
    let last;
    for (let i = 0; i < 60; i++) {
      last = await t.request('GET', '/v1/me', { key: s.key });
      if (last.status !== 200) break;
    }
    // If the minute rolled over mid-loop the count restarts, so allow for that.
    expect(last!.status).toBe(200);
    expect(last!.headers.get('ratelimit-limit')).toBe('60');
    let blocked = await t.request('GET', '/v1/me', { key: s.key });
    if (blocked.status === 200) {
      for (let i = 0; i < 60 && blocked.status === 200; i++) blocked = await t.request('GET', '/v1/me', { key: s.key });
    }
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('ratelimit-remaining')).toBe('0');

    // A second key for the same company shares the budget...
    const extra = await addKey(s.companyId, ['read']);
    expect((await t.request('GET', '/v1/me', { key: extra.key })).status).toBe(429);
    // ...while another company is unaffected.
    const other = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });
    expect((await t.request('GET', '/v1/me', { key: other.key })).status).toBe(200);
  });
});

describe('audit log', () => {
  it('records who did what, newest first', async () => {
    const t = makeApp();
    const a = await createCompany();
    const job = await postJob(t, a.key);
    const app = await apply(t, a.key, job);
    await t.request('POST', `/v1/applications/${app.id}/stage`, { key: a.key, body: { to: 'screen' } });
    const log = await t.request('GET', '/v1/audit-log', { key: a.key, headers: { 'User-Agent': 'audit-test' } });
    expect(log.body.data.map((e: { action: string }) => e.action)).toEqual([
      'application.stage_changed',
      'application.created',
      'candidate.created',
      'job.created',
    ]);
    expect(log.body.data[0]).toMatchObject({
      actor: `api_key:${a.keyId}`,
      entity_type: 'application',
      entity_id: app.id,
      metadata: { from: 'applied', to: 'screen' },
    });
    expect(log.body.data[0].request_id).toMatch(/^req_/);
    const filtered = await t.request('GET', `/v1/audit-log?entity_id=${job}`, { key: a.key });
    expect(filtered.body.data).toHaveLength(1);
  });

  it('does not record a change that failed', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    await t.request('POST', `/v1/applications/${app.id}/stage`, { key: a.key, body: { to: 'hired' } });
    const log = await t.request('GET', '/v1/audit-log?action=application.stage_changed', { key: a.key });
    expect(log.body.data).toHaveLength(0);
  });
});

describe('sandboxes', () => {
  it('creates a seeded demo company with a working key', async () => {
    const t = makeApp();
    const ip = { 'X-Real-IP': `203.0.113.${Math.floor(Math.random() * 250)}` };
    const res = await t.request('POST', '/v1/sandbox', { headers: ip });
    expect(res.status).toBe(201);
    expect(res.body.api_key).toMatch(/^mh_sandbox_/);
    expect(res.body.company.plan).toBe('sandbox');
    expect(res.body.company.name).toBe('Meridian Interface Staffing (sandbox)');
    const key = res.body.api_key;

    const me = await t.request('GET', '/v1/me', { key });
    expect(me.body.principal.scopes).toEqual(['read', 'write', 'admin']);
    const pipeline = await t.request('GET', '/v1/pipeline', { key });
    expect(pipeline.body.total).toBe(21);
    expect(pipeline.body.stages.hired).toBe(1);
    expect((await t.request('GET', '/v1/jobs?status=open', { key })).body.data).toHaveLength(4);
    const interview = await t.request('GET', '/v1/applications?stage=interview', { key });
    expect(interview.body.data.length).toBeGreaterThan(0);
    const history = await t.request('GET', `/v1/applications/${interview.body.data[0].id}/history`, { key });
    expect(history.body.data.map((h: { to_stage: string }) => h.to_stage)).toEqual(['applied', 'screen', 'interview']);
    // Each sample application starts clean: no note carried over from the one before.
    expect(history.body.data[0].note).toBeNull();
    expect(t.storage.files.size).toBe(6);
    const hooks = await t.request('GET', '/v1/webhooks', { key });
    expect(hooks.body.data[0].url).toBe('http://localhost:8787/demo/webhook-inbox');
    // Seeding produces no webhook backlog.
    expect(
      await testSql()`select 1 from hire.webhook_deliveries where company_id = ${res.body.company.id}`,
    ).toHaveLength(0);
  });

  it('limits how many one address can create', async () => {
    const t = makeApp();
    const ip = { 'X-Real-IP': `198.51.100.${Math.floor(Math.random() * 250)}` };
    for (let i = 0; i < 5; i++) expect((await t.request('POST', '/v1/sandbox', { headers: ip })).status).toBe(201);
    const sixth = await t.request('POST', '/v1/sandbox', { headers: ip });
    expect(sixth.status).toBe(429);
  });

  it('cleans up expired sandboxes and their files', async () => {
    const t = makeApp();
    const res = await t.request('POST', '/v1/sandbox', { headers: { 'X-Real-IP': '192.0.2.77' } });
    const id = res.body.company.id;
    expect(t.storage.files.size).toBe(6);
    await testSql()`update hire.companies set expires_at = now() - interval '1 second' where id = ${id}`;
    expect((await t.request('GET', '/v1/me', { key: res.body.api_key })).status).toBe(401);
    const tick = await t.request('POST', '/internal/tick', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(tick.body.maintenance.sandboxes_deleted).toBeGreaterThanOrEqual(1);
    expect(await testSql()`select 1 from hire.companies where id = ${id}`).toHaveLength(0);
    expect(t.storage.files.size).toBe(0);
  });

  it('protects the maintenance endpoint', async () => {
    const t = makeApp();
    expect((await t.request('POST', '/internal/tick')).status).toBe(401);
    expect((await t.request('POST', '/internal/tick', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    const noSecret = makeApp({ cronSecret: undefined });
    expect((await noSecret.request('POST', '/internal/tick', { headers: { Authorization: 'Bearer ' } })).status).toBe(
      401,
    );
  });

  it('verifies webhook signatures at the demo receiver', async () => {
    const t = makeApp();
    const res = await t.request('POST', '/v1/sandbox', { headers: { 'X-Real-IP': '192.0.2.88' } });
    const key = res.body.api_key;
    const hooks = await t.request('GET', '/v1/webhooks', { key });
    const sql = testSql();
    // Point the sandbox's receiver at this in-process app for the test.
    const [delivery] = await sql`
      insert into hire.webhook_deliveries (company_id, endpoint_id, event_id, event_type, payload)
      values (${res.body.company.id}, ${hooks.body.data[0].id}, gen_random_uuid(), 'ping', '{"type":"ping"}')
      returning id`;
    const bad = await t.request('POST', '/demo/webhook-inbox', {
      body: '{"type":"ping"}',
      headers: { 'Meridian-Delivery': delivery!.id, 'Meridian-Signature': 't=1,v1=00' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('API reference', () => {
  it('publishes an OpenAPI document covering every endpoint', async () => {
    const t = makeApp();
    const res = await t.request('GET', '/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    const paths = Object.keys(res.body.paths);
    for (const p of [
      '/v1/jobs',
      '/v1/candidates/{id}',
      '/v1/applications/{id}/stage',
      '/v1/webhooks',
      '/v1/sandbox',
      '/v1/audit-log',
    ]) {
      expect(paths).toContain(p);
    }
    let operations = 0;
    for (const item of Object.values(res.body.paths) as Record<string, { summary?: string; responses?: object }>[]) {
      for (const op of Object.values(item)) {
        operations++;
        expect(op.summary).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length).toBeGreaterThan(0);
      }
    }
    expect(operations).toBeGreaterThanOrEqual(28);
    expect(res.body.components.schemas.Problem).toBeTruthy();
  });

  it('serves the interactive docs page', async () => {
    const t = makeApp();
    const res = await t.request('GET', '/docs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('integrity="sha384-');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
