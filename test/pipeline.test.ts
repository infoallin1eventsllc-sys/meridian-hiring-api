import { describe, expect, it } from 'vitest';
import { allowedMoves } from '../src/routes/applications.js';
import { apply, candidateInput, createCompany, makeApp, postJob } from './helpers.js';

const move = (t: ReturnType<typeof makeApp>, key: string, id: string, body: Record<string, unknown>) =>
  t.request('POST', `/v1/applications/${id}/stage`, { key, body });

describe('applications and the hiring pipeline', () => {
  it('creates a candidate on apply, and reuses them when they apply again', async () => {
    const t = makeApp();
    const a = await createCompany();
    const design = await postJob(t, a.key, { title: 'Designer' });
    const eng = await postJob(t, a.key, { title: 'Engineer' });
    const person = candidateInput({ email: 'Priya.Raman@Example.com' });
    const first = await apply(t, a.key, design, person);
    expect(first).toMatchObject({
      stage: 'applied',
      job: { title: 'Designer' },
      candidate: { email: 'priya.raman@example.com' },
    });
    const second = await apply(t, a.key, eng, { ...person, email: 'priya.raman@example.com' });
    expect(second.candidate_id).toBe(first.candidate_id);

    const dup = await t.request('POST', '/v1/applications', {
      key: a.key,
      body: { job_id: design, candidate_id: first.candidate_id },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.existing_id).toBe(first.id);
  });

  it('only takes applications for open jobs', async () => {
    const t = makeApp();
    const a = await createCompany();
    const job = await postJob(t, a.key, { status: 'closed' });
    const res = await t.request('POST', '/v1/applications', {
      key: a.key,
      body: { job_id: job, candidate: candidateInput() },
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/closed/);
  });

  it('needs exactly one of candidate_id or candidate', async () => {
    const t = makeApp();
    const a = await createCompany();
    const job = await postJob(t, a.key);
    expect((await t.request('POST', '/v1/applications', { key: a.key, body: { job_id: job } })).status).toBe(422);
  });

  it('moves through the stages and records every move', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    for (const to of ['screen', 'interview', 'offer', 'hired']) {
      const res = await move(t, a.key, app.id, { to, note: `Moved to ${to}` });
      expect(res.status, to).toBe(200);
      expect(res.body.stage).toBe(to);
    }
    const history = await t.request('GET', `/v1/applications/${app.id}/history`, { key: a.key });
    expect(history.body.data.map((h: { from_stage: string; to_stage: string }) => [h.from_stage, h.to_stage])).toEqual([
      [null, 'applied'],
      ['applied', 'screen'],
      ['screen', 'interview'],
      ['interview', 'offer'],
      ['offer', 'hired'],
    ]);
    expect(history.body.data[4]).toMatchObject({ note: 'Moved to hired', changed_by: `api_key:${a.keyId}` });
  });

  it('refuses moves the pipeline does not allow, and says what is allowed', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    const skipToHired = await move(t, a.key, app.id, { to: 'hired' });
    expect(skipToHired.status).toBe(409);
    expect(skipToHired.body).toMatchObject({ code: 'invalid_transition', from: 'applied', to: 'hired' });
    expect(skipToHired.body.allowed).toEqual(['screen', 'interview', 'offer', 'rejected']);
    expect((await move(t, a.key, app.id, { to: 'applied' })).body.code).toBe('invalid_transition');

    const reject = await move(t, a.key, app.id, { to: 'rejected', rejection_reason: 'Role filled' });
    expect(reject.body).toMatchObject({ stage: 'rejected', rejection_reason: 'Role filled' });
    const reopen = await move(t, a.key, app.id, { to: 'screen' });
    expect(reopen.status).toBe(409);
    expect(reopen.body.detail).toMatch(/final/);
  });

  it('only accepts a rejection reason when rejecting', async () => {
    const t = makeApp();
    const a = await createCompany();
    const app = await apply(t, a.key, await postJob(t, a.key));
    expect((await move(t, a.key, app.id, { to: 'screen', rejection_reason: 'x' })).status).toBe(422);
  });

  it('knows the rules', () => {
    expect(allowedMoves('interview')).toEqual(['applied', 'screen', 'offer', 'rejected']);
    expect(allowedMoves('offer')).toContain('hired');
    expect(allowedMoves('hired')).toEqual([]);
    expect(allowedMoves('rejected')).toEqual([]);
  });

  it('finds everyone in Interview for one job, and combines filters', async () => {
    const t = makeApp();
    const a = await createCompany();
    const design = await postJob(t, a.key, { title: 'Designer' });
    const eng = await postJob(t, a.key, { title: 'Engineer' });
    const toInterview = async (job: string, name: string) => {
      const app = await apply(t, a.key, job, candidateInput({ first_name: name }));
      await move(t, a.key, app.id, { to: 'interview' });
      return app.id;
    };
    const wanted = [await toInterview(design, 'Ada'), await toInterview(design, 'Grace')];
    await toInterview(eng, 'Linus');
    await apply(t, a.key, design, candidateInput({ first_name: 'Still applied' }));

    const res = await t.request('GET', `/v1/applications?job_id=${design}&stage=interview`, { key: a.key });
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: { id: string }) => x.id).sort()).toEqual(wanted.sort());

    const several = await t.request('GET', '/v1/applications?stage=interview,applied', { key: a.key });
    expect(several.body.data).toHaveLength(4);
    const byName = await t.request('GET', '/v1/applications?q=grace', { key: a.key });
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].candidate.first_name).toBe('Grace');

    const counts = await t.request('GET', `/v1/pipeline?job_id=${design}`, { key: a.key });
    expect(counts.body).toMatchObject({ total: 3, stages: { applied: 1, interview: 2, hired: 0 } });
  });

  it('pages through results without repeats or gaps', async () => {
    const t = makeApp();
    const a = await createCompany();
    const job = await postJob(t, a.key);
    const created = new Set<string>();
    for (let i = 0; i < 7; i++) created.add((await apply(t, a.key, job)).id);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { data: { id: string }[]; next_cursor: string | null } } = await t.request(
        'GET',
        `/v1/applications?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        { key: a.key },
      );
      seen.push(...res.body.data.map((x) => x.id));
      cursor = res.body.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(created);
  });

  it('searches jobs and candidates', async () => {
    const t = makeApp();
    const a = await createCompany();
    await postJob(t, a.key, { title: 'Senior Product Designer', department: 'Design' });
    await postJob(t, a.key, { title: 'Accountant', location: 'Houston, TX' });
    expect((await t.request('GET', '/v1/jobs?q=designer', { key: a.key })).body.data).toHaveLength(1);
    expect((await t.request('GET', '/v1/jobs?q=houston', { key: a.key })).body.data).toHaveLength(1);
    expect((await t.request('GET', '/v1/jobs?q=100%25', { key: a.key })).body.data).toHaveLength(0);

    const email = `exact.${Date.now()}@example.com`;
    await t.request('POST', '/v1/candidates', { key: a.key, body: candidateInput({ last_name: 'Okonkwo', email }) });
    expect((await t.request('GET', '/v1/candidates?q=okonk', { key: a.key })).body.data).toHaveLength(1);
    expect(
      (await t.request('GET', `/v1/candidates?email=${email.toUpperCase()}`, { key: a.key })).body.data,
    ).toHaveLength(1);
    const dup = await t.request('POST', '/v1/candidates', { key: a.key, body: candidateInput({ email }) });
    expect(dup.status).toBe(409);
    expect(dup.body.existing_id).toBeTruthy();
  });

  it('protects jobs that have applications from deletion', async () => {
    const t = makeApp();
    const a = await createCompany();
    const job = await postJob(t, a.key);
    await apply(t, a.key, job);
    expect((await t.request('DELETE', `/v1/jobs/${job}`, { key: a.key })).status).toBe(409);
    const empty = await postJob(t, a.key);
    expect((await t.request('DELETE', `/v1/jobs/${empty}`, { key: a.key })).status).toBe(204);
  });
});
