import { describe, expect, it } from 'vitest';
import { SANDBOX_QUOTAS } from '../src/quotas.js';
import { webhookUrlProblem, isBlockedAddress } from '../src/webhooks.js';
import { apply, createCompany, makeApp, postJob, testSql } from './helpers.js';

const sandbox = () => createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });

describe('sandbox limits', () => {
  it('caps how much a sandbox can store', async () => {
    const t = makeApp();
    const s = await sandbox();
    for (let i = 0; i < SANDBOX_QUOTAS.api_keys - 1; i++) {
      expect((await t.request('POST', '/v1/api-keys', { key: s.key, body: { name: `k${i}` } })).status).toBe(201);
    }
    const over = await t.request('POST', '/v1/api-keys', { key: s.key, body: { name: 'one too many' } });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ quota: 'api_keys', limit: SANDBOX_QUOTAS.api_keys });

    // Pretend the sandbox is already full of jobs.
    await testSql()`
      insert into hire.jobs (company_id, title)
      select ${s.companyId}, 'Filler ' || g from generate_series(1, ${SANDBOX_QUOTAS.jobs}) g`;
    const job = await t.request('POST', '/v1/jobs', { key: s.key, body: { title: 'Fifty-first' } });
    expect(job.status).toBe(409);
    expect(job.body.quota).toBe('jobs');
  });

  it('does not apply sandbox caps to real plans', async () => {
    const t = makeApp();
    const a = await createCompany({ plan: 'starter' });
    for (let i = 0; i < SANDBOX_QUOTAS.api_keys + 1; i++) {
      expect((await t.request('POST', '/v1/api-keys', { key: a.key, body: { name: `k${i}` } })).status).toBe(201);
    }
  });

  it('only lets sandboxes send webhooks to the demo receiver or a webhook.site inbox', async () => {
    const t = makeApp({ allowPrivateWebhooks: false });
    const s = await sandbox();
    const post = (url: string) => t.request('POST', '/v1/webhooks', { key: s.key, body: { url } });
    expect((await post('https://example.com/hook')).status).toBe(422);
    expect((await post('https://webhook.site/not-a-uuid')).status).toBe(422);
    // Its own host is allowed only at the exact receiver path.
    expect((await post('http://localhost:8787/v1/sandbox')).status).toBe(422);
    expect((await post('https://webhook.site/8f14e45f-ceea-467a-9575-2f1c0e2d3b4a')).status).toBe(201);
  });
});

describe('input hardening', () => {
  it('rejects cursors with a forged id instead of erroring', async () => {
    const t = makeApp();
    const a = await createCompany();
    const forged = Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000Z', 'nope'])).toString('base64url');
    expect((await t.request('GET', `/v1/jobs?cursor=${forged}`, { key: a.key })).status).toBe(422);
    expect((await t.request('GET', `/v1/audit-log?cursor=${forged}`, { key: a.key })).status).toBe(422);
  });

  it('refuses zip files that are not Word documents', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode('payload/evil.exe')]);
    const fd = new FormData();
    fd.append('file', new File([zip], 'resume.docx'));
    const res = await t.request('POST', `/v1/candidates/${app.candidate_id}/resumes`, { key: a.key, form: fd });
    expect(res.status).toBe(415);
  });

  it('does not leak database constraint names', async () => {
    const t = makeApp();
    const a = await createCompany();
    const job = await postJob(t, a.key);
    const app = await apply(t, a.key, job);
    const dup = await t.request('POST', '/v1/applications', {
      key: a.key,
      body: { job_id: job, candidate_id: app.candidate_id },
    });
    expect(JSON.stringify(dup.body)).not.toMatch(/constraint|_key|_fkey/);
  });

  it('answers junk at the demo receiver without a server error', async () => {
    const t = makeApp();
    const dashes = '-'.repeat(36);
    const res = await t.request('POST', '/demo/webhook-inbox', {
      body: '{}',
      headers: { 'Meridian-Delivery': dashes },
    });
    expect(res.status).toBe(400);
  });

  it('blocks tunnelled, documentation and non-standard-port webhook targets', () => {
    for (const ip of ['64:ff9b::a00:1', '2002:a00:1::1', '2001:0:4136:e378::1', '192.0.2.10', '203.0.113.5']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(webhookUrlProblem('https://example.com:8443/hook', false)).toMatch(/443/);
    expect(webhookUrlProblem('https://example.com:443/hook', false)).toBeUndefined();
  });
});
