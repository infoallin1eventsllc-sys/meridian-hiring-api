import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { apply, candidateInput, createCompany, makeApp, postJob, testSql } from './helpers.js';

describe('company isolation', () => {
  describe('in the database itself (row-level security)', () => {
    it('shows a company only its own rows, even when a query has no WHERE clause', async () => {
      const t = makeApp();
      const a = await createCompany();
      const b = await createCompany();
      await apply(t, a.key, await postJob(t, a.key), candidateInput());
      await apply(t, b.key, await postJob(t, b.key), candidateInput());

      const seenByA = await withTenant(testSql(), { companyId: a.companyId, actor: 'test' }, async (tx) => ({
        jobs: await tx`select company_id from hire.jobs`,
        candidates: await tx`select company_id from hire.candidates`,
        applications: await tx`select company_id from hire.applications`,
        history: await tx`select company_id from hire.stage_history`,
        companies: await tx`select id from hire.companies`,
      }));
      for (const rows of Object.values(seenByA)) {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.company_id ?? row.id).toBe(a.companyId);
      }
    });

    it('sees nothing when no company is set', async () => {
      const rows = await testSql().begin(async (tx) => {
        await tx`set local role hire_app`;
        return tx`select id from hire.jobs`;
      });
      expect(rows).toHaveLength(0);
    });

    it("refuses to write a row into another company's data", async () => {
      const a = await createCompany();
      const b = await createCompany();
      await expect(
        withTenant(
          testSql(),
          { companyId: a.companyId, actor: 'test' },
          (tx) => tx`insert into hire.jobs (company_id, title) values (${b.companyId}, 'Sneaky job')`,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("can't attach another company's candidate to an application", async () => {
      const t = makeApp();
      const a = await createCompany();
      const b = await createCompany();
      const jobA = await postJob(t, a.key);
      const candB = await t.request('POST', '/v1/candidates', { key: b.key, body: candidateInput() });
      // Even bypassing the API's checks, the composite foreign key blocks it.
      await expect(
        withTenant(
          testSql(),
          { companyId: a.companyId, actor: 'test' },
          (tx) =>
            tx`insert into hire.applications (company_id, job_id, candidate_id) values (${a.companyId}, ${jobA}, ${candB.body.id})`,
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it('does not let the API role edit or delete history or audit entries', async () => {
      const t = makeApp();
      const a = await createCompany();
      await apply(t, a.key, await postJob(t, a.key));
      const ctx = { companyId: a.companyId, actor: 'test' };
      await expect(
        withTenant(testSql(), ctx, (tx) => tx`update hire.stage_history set note = 'edited'`),
      ).rejects.toThrow(/permission denied/);
      await expect(withTenant(testSql(), ctx, (tx) => tx`delete from hire.audit_log`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('through the API', () => {
    it("returns 404 for another company's records and leaves them untouched", async () => {
      const t = makeApp();
      const a = await createCompany();
      const b = await createCompany();
      const jobA = await postJob(t, a.key, { title: 'Company A only' });
      const appA = await apply(t, a.key, jobA);

      for (const [method, path, body] of [
        ['GET', `/v1/jobs/${jobA}`],
        ['PATCH', `/v1/jobs/${jobA}`, { title: 'Hijacked' }],
        ['DELETE', `/v1/jobs/${jobA}`],
        ['GET', `/v1/candidates/${appA.candidate_id}`],
        ['DELETE', `/v1/candidates/${appA.candidate_id}`],
        ['GET', `/v1/applications/${appA.id}`],
        ['GET', `/v1/applications/${appA.id}/history`],
        ['POST', `/v1/applications/${appA.id}/stage`, { to: 'screen' }],
        ['GET', `/v1/candidates/${appA.candidate_id}/resumes`],
      ] as const) {
        const res = await t.request(method, path, { key: b.key, body });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.code).toBe('not_found');
      }

      const jobs = await t.request('GET', '/v1/jobs', { key: b.key });
      expect(jobs.body.data.map((j: { id: string }) => j.id)).not.toContain(jobA);
      const stillThere = await t.request('GET', `/v1/applications/${appA.id}`, { key: a.key });
      expect(stillThere.body.stage).toBe('applied');
      expect(stillThere.body.job.title).toBe('Company A only');
    });

    it("can't apply to another company's job", async () => {
      const t = makeApp();
      const a = await createCompany();
      const b = await createCompany();
      const jobA = await postJob(t, a.key);
      const res = await t.request('POST', '/v1/applications', {
        key: b.key,
        body: { job_id: jobA, candidate: candidateInput() },
      });
      expect(res.status).toBe(404);
    });

    it('lets two companies hold a candidate with the same email', async () => {
      const t = makeApp();
      const a = await createCompany();
      const b = await createCompany();
      const person = candidateInput({ email: `shared.${Date.now()}@example.com` });
      expect((await t.request('POST', '/v1/candidates', { key: a.key, body: person })).status).toBe(201);
      expect((await t.request('POST', '/v1/candidates', { key: b.key, body: person })).status).toBe(201);
    });
  });
});
