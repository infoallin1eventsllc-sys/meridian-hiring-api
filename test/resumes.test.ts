import { describe, expect, it } from 'vitest';
import { samplePdf } from '../src/seed.js';
import { apply, createCompany, makeApp, postJob, testSql } from './helpers.js';

function form(bytes: Uint8Array, name: string, type = 'application/pdf') {
  const fd = new FormData();
  fd.append('file', new File([bytes as unknown as BlobPart], name, { type }));
  return fd;
}

describe('résumés', () => {
  it('stores a PDF privately and hands out a short-lived link', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const pdf = samplePdf(['Jordan Avery']);
    const up = await t.request('POST', `/v1/candidates/${app.candidate_id}/resumes`, {
      key: a.key,
      form: form(pdf, '../../etc/Jordan CV.pdf'),
    });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({
      content_type: 'application/pdf',
      size_bytes: pdf.byteLength,
      file_name: 'Jordan CV.pdf',
    });
    expect(up.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.storage.files.size).toBe(1);
    const [path] = [...t.storage.files.keys()];
    expect(path!.startsWith(`${a.companyId}/${app.candidate_id}/`)).toBe(true);

    const list = await t.request('GET', `/v1/candidates/${app.candidate_id}/resumes`, { key: a.key });
    expect(list.body.data).toHaveLength(1);
    const link = await t.request('GET', `/v1/resumes/${up.body.id}/download`, { key: a.key });
    expect(link.status).toBe(200);
    expect(new Date(link.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(300_000);

    const other = await createCompany();
    expect((await t.request('GET', `/v1/resumes/${up.body.id}/download`, { key: other.key })).status).toBe(404);
  });

  it('judges file type by content, not by name', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const fake = new TextEncoder().encode('#!/bin/sh\necho not a resume');
    const res = await t.request('POST', `/v1/candidates/${app.candidate_id}/resumes`, {
      key: a.key,
      form: form(fake, 'resume.pdf'),
    });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('unsupported_media_type');
    expect(t.storage.files.size).toBe(0);
  });

  it('enforces size limits, tighter for sandboxes', async () => {
    const t = makeApp();
    const s = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });
    const app = await apply(t, s.key, await postJob(t, s.key));
    const big = new Uint8Array(1.5 * 1024 * 1024);
    big.set(new TextEncoder().encode('%PDF-1.4'));
    const res = await t.request('POST', `/v1/candidates/${app.candidate_id}/resumes`, {
      key: s.key,
      form: form(big, 'big.pdf'),
    });
    expect(res.status).toBe(413);

    const huge = new Uint8Array(5 * 1024 * 1024);
    huge.set(new TextEncoder().encode('%PDF-1.4'));
    const a = await createCompany();
    const appA = await apply(t, a.key, await postJob(t, a.key));
    expect(
      (
        await t.request('POST', `/v1/candidates/${appA.candidate_id}/resumes`, {
          key: a.key,
          form: form(huge, 'huge.pdf'),
        })
      ).status,
    ).toBe(413);
  });

  it('requires a file field', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const res = await t.request('POST', `/v1/candidates/${app.candidate_id}/resumes`, {
      key: a.key,
      form: new FormData(),
    });
    expect(res.status).toBe(422);
  });

  it('erases a candidate completely on request', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    await t.request('POST', `/v1/applications/${app.id}/stage`, {
      key: a.key,
      body: { to: 'screen', note: 'Lovely call' },
    });
    await t.request('POST', `/v1/candidates/${app.candidate_id}/resumes`, {
      key: a.key,
      form: form(samplePdf(['x']), 'cv.pdf'),
    });
    expect(t.storage.files.size).toBe(1);

    const erase = await t.request('DELETE', `/v1/candidates/${app.candidate_id}`, { key: a.key });
    expect(erase.status).toBe(204);
    expect(t.storage.files.size).toBe(0);
    expect((await t.request('GET', `/v1/applications/${app.id}`, { key: a.key })).status).toBe(404);
    const sql = testSql();
    expect(await sql`select 1 from hire.stage_history where application_id = ${app.id}`).toHaveLength(0);
    expect(await sql`select 1 from hire.resumes where candidate_id = ${app.candidate_id}`).toHaveLength(0);
    expect(await sql`select 1 from hire.pending_file_deletions where company_id = ${a.companyId}`).toHaveLength(0);

    const log = await t.request('GET', `/v1/audit-log?action=candidate.erased`, { key: a.key });
    expect(log.body.data[0]).toMatchObject({
      entity_id: app.candidate_id,
      metadata: { applications_deleted: 1, resumes_deleted: 1 },
    });
    expect(JSON.stringify(log.body)).not.toContain(app.candidate.email);
  });

  it('keeps erased files queued if storage is down, then retries them', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    await t.request('POST', `/v1/candidates/${app.candidate_id}/resumes`, {
      key: a.key,
      form: form(samplePdf(['x']), 'cv.pdf'),
    });
    const realRemove = t.storage.remove.bind(t.storage);
    t.storage.remove = async () => {
      throw new Error('storage offline');
    };
    expect((await t.request('DELETE', `/v1/candidates/${app.candidate_id}`, { key: a.key })).status).toBe(204);
    expect(await testSql()`select 1 from hire.pending_file_deletions where company_id = ${a.companyId}`).toHaveLength(
      1,
    );

    t.storage.remove = realRemove;
    const tick = await t.request('POST', '/internal/tick', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(tick.status).toBe(200);
    expect(t.storage.files.size).toBe(0);
    expect(await testSql()`select 1 from hire.pending_file_deletions where company_id = ${a.companyId}`).toHaveLength(
      0,
    );
  });
});
