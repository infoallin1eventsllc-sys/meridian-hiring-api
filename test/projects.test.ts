import { describe, expect, it } from 'vitest';
import { samplePdf } from '../src/seed.js';
import { apply, candidateInput, createCompany, makeApp, postJob, testSql } from './helpers.js';

function form(bytes: Uint8Array, name: string, type = 'application/zip') {
  const fd = new FormData();
  fd.append('file', new File([bytes as unknown as BlobPart], name, { type }));
  return fd;
}

// The smallest valid ZIP header is enough: files are stored, never unpacked.
const zip = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return bytes;
};

describe('GitHub profiles', () => {
  it('saves a GitHub profile link with the application', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(
      t,
      a.key,
      await postJob(t, a.key),
      candidateInput({ github_url: 'https://github.com/jordan-avery' }),
    );
    const cand = await t.request('GET', `/v1/candidates/${app.candidate_id}`, { key: a.key });
    expect(cand.body.github_url).toBe('https://github.com/jordan-avery');
  });

  it('refuses links that are not a GitHub profile', async () => {
    const t = makeApp();
    const a = await createCompany();
    const job = await postJob(t, a.key);
    for (const github_url of [
      'https://evil.example.com/jordan',
      'http://github.com/jordan',
      'https://github.com/jordan/repo',
      'javascript:alert(1)',
    ]) {
      const res = await t.request('POST', '/v1/applications', {
        key: a.key,
        body: { job_id: job, candidate: candidateInput({ github_url }) },
      });
      expect(res.status, github_url).toBe(422);
      expect(res.body.errors[0].path).toBe('candidate.github_url');
    }
  });
});

describe('projects', () => {
  it('adds a project with a GitHub repository, attaches a file and hands out a short-lived link', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const created = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
      key: a.key,
      body: {
        title: 'Shift scheduler',
        description: 'Scheduling for a 40-person clinic.',
        repo_url: 'https://github.com/jordan-avery/shift-scheduler',
        live_url: 'https://shifts.example.com',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ object: 'project', title: 'Shift scheduler', file: null });

    const up = await t.request('POST', `/v1/projects/${created.body.id}/file`, {
      key: a.key,
      form: form(zip(), '../../shift-scheduler.zip'),
    });
    expect(up.status).toBe(200);
    expect(up.body.file).toMatchObject({ file_name: 'shift-scheduler.zip', content_type: 'application/zip' });
    const [path] = [...t.storage.files.keys()];
    expect(path!.startsWith(`${a.companyId}/${app.candidate_id}/projects/`)).toBe(true);

    const list = await t.request('GET', `/v1/candidates/${app.candidate_id}/projects`, { key: a.key });
    expect(list.body.data).toHaveLength(1);
    const link = await t.request('GET', `/v1/projects/${created.body.id}/download`, { key: a.key });
    expect(link.status).toBe(200);

    const other = await createCompany();
    expect((await t.request('GET', `/v1/projects/${created.body.id}/download`, { key: other.key })).status).toBe(404);
    expect((await t.request('GET', `/v1/candidates/${app.candidate_id}/projects`, { key: other.key })).status).toBe(
      404,
    );
  });

  it('only accepts GitHub repository links for repo_url', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    for (const repo_url of ['https://github.com/jordan', 'https://gitlab.example.com/a/b', 'ftp://github.com/a/b']) {
      const res = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
        key: a.key,
        body: { title: 'X', repo_url },
      });
      expect(res.status, repo_url).toBe(422);
    }
    const deep = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
      key: a.key,
      body: { title: 'X', repo_url: 'https://github.com/jordan/app/tree/main/web' },
    });
    expect(deep.status).toBe(201);
  });

  it('judges project files by content and replaces the old file', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const p = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
      key: a.key,
      body: { title: 'Portfolio' },
    });
    const script = new TextEncoder().encode('#!/bin/sh\necho hi');
    const bad = await t.request('POST', `/v1/projects/${p.body.id}/file`, {
      key: a.key,
      form: form(script, 'project.zip'),
    });
    expect(bad.status).toBe(415);
    expect(t.storage.files.size).toBe(0);

    await t.request('POST', `/v1/projects/${p.body.id}/file`, { key: a.key, form: form(zip(), 'v1.zip') });
    const pdf = await t.request('POST', `/v1/projects/${p.body.id}/file`, {
      key: a.key,
      form: form(samplePdf(['Case study']), 'case-study.pdf', 'application/pdf'),
    });
    expect(pdf.status).toBe(200);
    expect(pdf.body.file.content_type).toBe('application/pdf');
    expect(t.storage.files.size).toBe(1);
  });

  it('keeps sandbox project files small', async () => {
    const t = makeApp();
    const s = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });
    const app = await apply(t, s.key, await postJob(t, s.key));
    const p = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
      key: s.key,
      body: { title: 'Big' },
    });
    const res = await t.request('POST', `/v1/projects/${p.body.id}/file`, {
      key: s.key,
      form: form(zip(3 * 1024 * 1024), 'big.zip'),
    });
    expect(res.status).toBe(413);
  });

  it('needs the write scope to add or delete', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const { addKey } = await import('./helpers.js');
    const reader = await addKey(a.companyId, ['read']);
    const res = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
      key: reader.key,
      body: { title: 'X' },
    });
    expect(res.status).toBe(403);
  });

  it('deleting a project removes its file', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const p = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
      key: a.key,
      body: { title: 'Gone soon' },
    });
    await t.request('POST', `/v1/projects/${p.body.id}/file`, { key: a.key, form: form(zip(), 'a.zip') });
    expect((await t.request('DELETE', `/v1/projects/${p.body.id}`, { key: a.key })).status).toBe(204);
    expect(t.storage.files.size).toBe(0);
    expect(await testSql()`select 1 from hire.pending_file_deletions where company_id = ${a.companyId}`).toHaveLength(
      0,
    );
  });

  it('erasing a candidate takes their projects and project files too', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const p = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
      key: a.key,
      body: { title: 'App', repo_url: 'https://github.com/jordan/app' },
    });
    await t.request('POST', `/v1/projects/${p.body.id}/file`, { key: a.key, form: form(zip(), 'app.zip') });
    expect((await t.request('DELETE', `/v1/candidates/${app.candidate_id}`, { key: a.key })).status).toBe(204);
    expect(t.storage.files.size).toBe(0);
    expect(await testSql()`select 1 from hire.projects where candidate_id = ${app.candidate_id}`).toHaveLength(0);
    const log = await t.request('GET', `/v1/audit-log?action=candidate.erased`, { key: a.key });
    expect(log.body.data[0].metadata).toMatchObject({ projects_deleted: 1 });
  });

  it('removes project files when a sandbox expires', async () => {
    const t = makeApp();
    const s = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });
    const app = await apply(t, s.key, await postJob(t, s.key));
    const p = await t.request('POST', `/v1/candidates/${app.candidate_id}/projects`, {
      key: s.key,
      body: { title: 'App' },
    });
    await t.request('POST', `/v1/projects/${p.body.id}/file`, { key: s.key, form: form(zip(), 'app.zip') });
    expect(t.storage.files.size).toBe(1);
    await testSql()`update hire.companies set expires_at = now() - interval '1 minute' where id = ${s.companyId}`;
    const tick = await t.request('POST', '/internal/tick', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(tick.status).toBe(200);
    expect(t.storage.files.size).toBe(0);
  });
});
