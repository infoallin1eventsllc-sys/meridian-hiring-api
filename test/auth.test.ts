import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addKey, createCompany, loginToken, makeApp, postJob, testSql } from './helpers.js';

async function addMember(companyId: string, userId: string, role: string) {
  await testSql()`insert into hire.company_members (company_id, user_id, role) values (${companyId}, ${userId}, ${role})`;
}

describe('authentication', () => {
  it('requires credentials and says how to send them', async () => {
    const t = makeApp();
    const res = await t.request('GET', '/v1/jobs');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'unauthorized', status: 401, title: 'Unauthorized' });
    expect(res.body.detail).toMatch(/Bearer/);
    expect(res.body.request_id).toMatch(/^req_/);
  });

  it('rejects unknown and revoked keys', async () => {
    const t = makeApp();
    const fake = `mh_live_${'x'.repeat(43)}`;
    expect((await t.request('GET', '/v1/me', { key: fake })).status).toBe(401);

    const a = await createCompany();
    const second = await addKey(a.companyId, ['read']);
    expect((await t.request('GET', '/v1/me', { key: second.key })).status).toBe(200);
    const revoke = await t.request('DELETE', `/v1/api-keys/${second.id}`, { key: a.key });
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked_at).toBeTruthy();
    expect((await t.request('GET', '/v1/me', { key: second.key })).status).toBe(401);
  });

  it('enforces scopes', async () => {
    const t = makeApp();
    const a = await createCompany();
    const readOnly = await addKey(a.companyId, ['read']);
    expect((await t.request('GET', '/v1/jobs', { key: readOnly.key })).status).toBe(200);
    const write = await t.request('POST', '/v1/jobs', { key: readOnly.key, body: { title: 'Nope' } });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('forbidden');
    const writer = await addKey(a.companyId, ['read', 'write']);
    expect(
      (await t.request('POST', '/v1/webhooks', { key: writer.key, body: { url: 'https://example.com/h' } })).status,
    ).toBe(403);
    expect((await t.request('GET', '/v1/audit-log', { key: writer.key })).status).toBe(403);
    // A write-only key (a careers page, say) can apply but can't read anyone's details.
    const careersPage = await addKey(a.companyId, ['write']);
    const read = await t.request('GET', '/v1/candidates', { key: careersPage.key });
    expect(read.status).toBe(403);
    expect(read.body.detail).toContain('"read"');
    expect((await t.request('GET', '/v1/me', { key: careersPage.key })).status).toBe(200);
  });

  it('creates keys that work, shows them once and stores only a hash', async () => {
    const t = makeApp();
    const a = await createCompany();
    const created = await t.request('POST', '/v1/api-keys', {
      key: a.key,
      body: { name: 'Careers site', scopes: ['read'] },
    });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^mh_live_/);
    expect((await t.request('GET', '/v1/me', { key: created.body.key })).body.principal.scopes).toEqual(['read']);
    const list = await t.request('GET', '/v1/api-keys', { key: a.key });
    expect(JSON.stringify(list.body)).not.toContain(created.body.key);
    const [stored] = await testSql()`select key_hash::text from hire.api_keys where id = ${created.body.id}`;
    expect(stored!.key_hash).not.toContain(created.body.key);
  });

  it("won't let a key revoke itself", async () => {
    const t = makeApp();
    const a = await createCompany();
    const res = await t.request('DELETE', `/v1/api-keys/${a.keyId}`, { key: a.key });
    expect(res.status).toBe(409);
  });

  it('rejects keys for expired sandboxes', async () => {
    const t = makeApp();
    const s = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() - 1000) });
    const res = await t.request('GET', '/v1/me', { key: s.key });
    expect(res.status).toBe(401);
    expect(res.body.detail).toMatch(/expired/);
  });

  describe('logins (Supabase tokens)', () => {
    it('gives members access with scopes from their role', async () => {
      const t = makeApp();
      const a = await createCompany();
      const recruiter = randomUUID();
      await addMember(a.companyId, recruiter, 'recruiter');
      const token = await loginToken(recruiter);
      const me = await t.request('GET', '/v1/me', { key: token });
      expect(me.status).toBe(200);
      expect(me.body.company.id).toBe(a.companyId);
      expect(me.body.principal).toMatchObject({ type: 'user', id: recruiter, scopes: ['read', 'write'] });
      expect((await t.request('POST', '/v1/jobs', { key: token, body: { title: 'From a login' } })).status).toBe(201);
      expect((await t.request('GET', '/v1/api-keys', { key: token })).status).toBe(403);

      const history = await t.request('GET', '/v1/audit-log', { key: a.key });
      expect(history.body.data[0]).toMatchObject({ action: 'job.created', actor: `user:${recruiter}` });
    });

    it('refuses tokens that are forged, expired, or belong to no company', async () => {
      const t = makeApp();
      const user = randomUUID();
      const a = await createCompany();
      await addMember(a.companyId, user, 'owner');
      expect(
        (
          await t.request('GET', '/v1/me', {
            key: await loginToken(user, { secret: 'wrong-secret-wrong-secret-wrong!!' }),
          })
        ).status,
      ).toBe(401);
      expect((await t.request('GET', '/v1/me', { key: await loginToken(user, { expiresIn: '-1m' }) })).status).toBe(
        401,
      );
      expect((await t.request('GET', '/v1/me', { key: await loginToken(randomUUID()) })).status).toBe(403);
      expect((await t.request('GET', '/v1/me', { key: 'not-a-token' })).status).toBe(401);
    });

    it('asks people in several companies which one they mean', async () => {
      const t = makeApp();
      const user = randomUUID();
      const a = await createCompany();
      const b = await createCompany();
      await addMember(a.companyId, user, 'viewer');
      await addMember(b.companyId, user, 'admin');
      const token = await loginToken(user);
      expect((await t.request('GET', '/v1/me', { key: token })).status).toBe(422);
      const asB = await t.request('GET', '/v1/me', { key: token, headers: { 'Meridian-Company': b.companyId } });
      expect(asB.body.company.id).toBe(b.companyId);
      expect(asB.body.principal.scopes).toContain('admin');
      const outsider = await createCompany();
      expect(
        (await t.request('GET', '/v1/me', { key: token, headers: { 'Meridian-Company': outsider.companyId } })).status,
      ).toBe(403);
      // A viewer in company A can read but not write there.
      const asA = { key: token, headers: { 'Meridian-Company': a.companyId } };
      expect((await t.request('POST', '/v1/jobs', { ...asA, body: { title: 'x' } })).status).toBe(403);
      await postJob(t, a.key);
      expect((await t.request('GET', '/v1/jobs', asA)).body.data).toHaveLength(1);
    });
  });
});
