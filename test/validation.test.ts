import { describe, expect, it } from 'vitest';
import { createCompany, makeApp, postJob } from './helpers.js';

describe('validation and error shapes', () => {
  it('explains every bad field', async () => {
    const t = makeApp();
    const a = await createCompany();
    const res = await t.request('POST', '/v1/candidates', {
      key: a.key,
      body: { first_name: '', email: 'not-an-email', linkedin_url: 'ftp://x', favourite_colour: 'blue' },
    });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'validation_failed', status: 422, title: 'Validation failed' });
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['first_name', 'last_name', 'email', 'linkedin_url']));
    // Unknown fields are refused rather than silently dropped.
    expect(JSON.stringify(res.body.errors)).toContain('favourite_colour');
  });

  it('rejects malformed JSON with its own code', async () => {
    const t = makeApp();
    const a = await createCompany();
    const res = await t.request('POST', '/v1/jobs', { key: a.key, body: '{"title": "oops"' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_json');
  });

  it('validates path and query parameters', async () => {
    const t = makeApp();
    const a = await createCompany();
    const badId = await t.request('GET', '/v1/jobs/not-a-uuid', { key: a.key });
    expect(badId.status).toBe(422);
    expect(badId.body.errors[0].path).toBe('param.id');
    expect((await t.request('GET', '/v1/jobs?limit=500', { key: a.key })).status).toBe(422);
    expect((await t.request('GET', '/v1/applications?stage=lunch', { key: a.key })).status).toBe(422);
    const cursor = await t.request('GET', '/v1/jobs?cursor=garbage', { key: a.key });
    expect(cursor.status).toBe(422);
    expect(cursor.body.errors[0].path).toBe('query.cursor');
  });

  it('requires at least one field on updates', async () => {
    const t = makeApp();
    const a = await createCompany();
    const job = await postJob(t, a.key);
    expect((await t.request('PATCH', `/v1/jobs/${job}`, { key: a.key, body: {} })).status).toBe(422);
    const ok = await t.request('PATCH', `/v1/jobs/${job}`, { key: a.key, body: { status: 'closed' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'closed', title: 'Backend Engineer', remote: false });
  });

  it('answers unknown routes with the same shape', async () => {
    const t = makeApp();
    const a = await createCompany();
    const res = await t.request('GET', '/v1/nothing-here', { key: a.key });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect((await t.request('GET', '/nothing-here')).body.code).toBe('not_found');
  });

  it('refuses oversized bodies', async () => {
    const t = makeApp();
    const a = await createCompany();
    const res = await t.request('POST', '/v1/jobs', {
      key: a.key,
      body: { title: 'Big', description: 'x'.repeat(1_100_000) },
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
  });

  it('stamps a request id on every response', async () => {
    const t = makeApp();
    const res = await t.request('GET', '/health');
    expect(res.headers.get('request-id')).toMatch(/^req_/);
    expect(res.body.status).toBe('ok');
  });

  it('sends visitors at / to the pipeline board', async () => {
    const t = makeApp();
    const res = await t.request('GET', '/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/index.html');
  });
});
