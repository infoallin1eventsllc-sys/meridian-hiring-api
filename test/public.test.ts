import { describe, expect, it } from 'vitest';
import { samplePdf } from '../src/seed.js';
import { createCompany, makeApp, postJob, testSql } from './helpers.js';

// Each test applies from its own address, so per-network limits don't spill between tests.
const net = () => ({ 'X-Real-IP': `198.51.100.${Math.floor(Math.random() * 250) + 1}` });

const applicant = (overrides: Record<string, unknown> = {}) => ({
  candidate: {
    first_name: 'Riley',
    last_name: 'Park',
    email: `riley.${Math.random().toString(36).slice(2, 8)}@example.com`,
    github_url: 'https://github.com/riley-park',
  },
  project: {
    title: 'Inventory tracker',
    repo_url: 'https://github.com/riley-park/inventory',
    description: 'Barcode scanning for a small warehouse.',
  },
  message: 'Happy to walk through the code.',
  consent: true,
  ...overrides,
});

function form(bytes: Uint8Array, name: string) {
  const fd = new FormData();
  fd.append('file', new File([bytes as unknown as BlobPart], name));
  return fd;
}
const zip = () => {
  const b = new Uint8Array(80);
  b.set([0x50, 0x4b, 0x03, 0x04]);
  return b;
};

async function setup() {
  const t = makeApp();
  const a = await createCompany({ name: 'Harbor Freight Logistics' });
  const job = await postJob(t, a.key, { title: 'Warehouse Systems Developer', description: 'Build our tools.' });
  return { t, a, job };
}

describe('apply page: reading a job', () => {
  it('shows an open job with no key, and nothing for drafts', async () => {
    const { t, a, job } = await setup();
    const res = await t.request('GET', `/v1/public/jobs/${job}`, { headers: net() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'public_job',
      title: 'Warehouse Systems Developer',
      company: { name: 'Harbor Freight Logistics', sandbox: false },
      accepting_applications: true,
    });
    expect(JSON.stringify(res.body)).not.toContain(a.companyId);

    const draft = await postJob(t, a.key, { title: 'Secret role', status: 'draft' });
    expect((await t.request('GET', `/v1/public/jobs/${draft}`, { headers: net() })).status).toBe(404);

    await t.request('PATCH', `/v1/jobs/${job}`, { key: a.key, body: { status: 'closed' } });
    const closed = await t.request('GET', `/v1/public/jobs/${job}`, { headers: net() });
    expect(closed.body.accepting_applications).toBe(false);
  });

  it('hides jobs of expired sandboxes', async () => {
    const t = makeApp();
    const s = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });
    const job = await postJob(t, s.key);
    await testSql()`update hire.companies set expires_at = now() - interval '1 minute' where id = ${s.companyId}`;
    expect((await t.request('GET', `/v1/public/jobs/${job}`, { headers: net() })).status).toBe(404);
  });

  it('short links open the apply page', async () => {
    const t = makeApp();
    const res = await t.request('GET', '/apply/5b3f8a5e-2c1d-4f7a-9a6e-0d1c2b3a4f5e');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/apply.html?job=5b3f8a5e-2c1d-4f7a-9a6e-0d1c2b3a4f5e');
  });
});

describe('apply page: applying', () => {
  it('creates the application with GitHub and project, then takes one résumé and one project file', async () => {
    const { t, a, job } = await setup();
    const headers = net();
    const res = await t.request('POST', `/v1/public/jobs/${job}/applications`, { headers, body: applicant() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ object: 'public_application', job_title: 'Warehouse Systems Developer' });
    const token = res.body.upload_token as string;

    // The employer sees it, marked as coming from the apply page.
    const app = await t.request('GET', `/v1/applications/${res.body.application_id}`, { key: a.key });
    expect(app.body.stage).toBe('applied');
    const cand = await t.request('GET', `/v1/candidates/${app.body.candidate_id}`, { key: a.key });
    expect(cand.body).toMatchObject({ github_url: 'https://github.com/riley-park', source: 'careers_page' });
    const history = await t.request('GET', `/v1/applications/${app.body.id}/history`, { key: a.key });
    expect(history.body.data[0]).toMatchObject({
      changed_by: 'public:apply_page',
      note: 'Happy to walk through the code.',
    });

    const auth = { ...headers, Authorization: `Bearer ${token}` };
    const cv = await t.request('POST', '/v1/public/uploads/resume', {
      headers: auth,
      form: form(samplePdf(['R']), 'cv.pdf'),
    });
    expect(cv.status).toBe(201);
    const again = await t.request('POST', '/v1/public/uploads/resume', {
      headers: auth,
      form: form(samplePdf(['R2']), 'cv2.pdf'),
    });
    expect(again.status).toBe(409);

    const file = await t.request('POST', '/v1/public/uploads/project-file', {
      headers: auth,
      form: form(zip(), 'code.zip'),
    });
    expect(file.status).toBe(200);
    expect(file.body.file.file_name).toBe('code.zip');
    const file2 = await t.request('POST', '/v1/public/uploads/project-file', {
      headers: auth,
      form: form(zip(), 'b.zip'),
    });
    expect(file2.status).toBe(409);

    const projects = await t.request('GET', `/v1/candidates/${app.body.candidate_id}/projects`, { key: a.key });
    expect(projects.body.data[0]).toMatchObject({
      title: 'Inventory tracker',
      repo_url: 'https://github.com/riley-park/inventory',
    });
    expect(t.storage.files.size).toBe(2);
  });

  it('refuses uploads without a valid token', async () => {
    const t = makeApp();
    const none = await t.request('POST', '/v1/public/uploads/resume', {
      headers: net(),
      form: form(samplePdf(['x']), 'a.pdf'),
    });
    expect(none.status).toBe(401);
    const forged = await t.request('POST', '/v1/public/uploads/resume', {
      headers: { ...net(), Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad' },
      form: form(samplePdf(['x']), 'a.pdf'),
    });
    expect(forged.status).toBe(401);
    // An API key is not an upload token.
    const a = await createCompany();
    const withKey = await t.request('POST', '/v1/public/uploads/resume', {
      headers: { ...net(), Authorization: `Bearer ${a.key}` },
      form: form(samplePdf(['x']), 'a.pdf'),
    });
    expect(withKey.status).toBe(401);
  });

  it('has no project file to take when no project was sent', async () => {
    const { t, job } = await setup();
    const headers = net();
    const res = await t.request('POST', `/v1/public/jobs/${job}/applications`, {
      headers,
      body: applicant({ project: undefined }),
    });
    const up = await t.request('POST', '/v1/public/uploads/project-file', {
      headers: { ...headers, Authorization: `Bearer ${res.body.upload_token}` },
      form: form(zip(), 'code.zip'),
    });
    expect(up.status).toBe(409);
  });

  it('needs consent and a valid GitHub link', async () => {
    const { t, job } = await setup();
    const noConsent = await t.request('POST', `/v1/public/jobs/${job}/applications`, {
      headers: net(),
      body: applicant({ consent: false }),
    });
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.errors[0].path).toBe('consent');
    const badRepo = await t.request('POST', `/v1/public/jobs/${job}/applications`, {
      headers: net(),
      body: applicant({ project: { title: 'X', repo_url: 'https://evil.example.com/a/b' } }),
    });
    expect(badRepo.status).toBe(422);
    expect(badRepo.body.errors[0].path).toBe('project.repo_url');
  });

  it('refuses closed jobs and second applications from the same email', async () => {
    const { t, a, job } = await setup();
    const body = applicant();
    expect((await t.request('POST', `/v1/public/jobs/${job}/applications`, { headers: net(), body })).status).toBe(201);
    const twice = await t.request('POST', `/v1/public/jobs/${job}/applications`, { headers: net(), body });
    expect(twice.status).toBe(409);
    expect(twice.body.detail).toMatch(/already applied/);
    expect(twice.body.existing_id).toBeUndefined();

    await t.request('PATCH', `/v1/jobs/${job}`, { key: a.key, body: { status: 'closed' } });
    const closed = await t.request('POST', `/v1/public/jobs/${job}/applications`, {
      headers: net(),
      body: applicant(),
    });
    expect(closed.status).toBe(409);
  });

  it('limits applications per network', async () => {
    const { t, job } = await setup();
    const headers = net();
    for (let i = 0; i < 10; i++) {
      const res = await t.request('POST', `/v1/public/jobs/${job}/applications`, { headers, body: applicant() });
      expect(res.status).toBe(201);
    }
    const res = await t.request('POST', `/v1/public/jobs/${job}/applications`, { headers, body: applicant() });
    expect(res.status).toBe(429);
  });

  it("applies the employer's sandbox caps", async () => {
    const t = makeApp();
    const s = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });
    const job = await postJob(t, s.key);
    const headers = net();
    const res = await t.request('POST', `/v1/public/jobs/${job}/applications`, { headers, body: applicant() });
    const big = new Uint8Array(1.5 * 1024 * 1024);
    big.set(new TextEncoder().encode('%PDF-1.4'));
    const up = await t.request('POST', '/v1/public/uploads/resume', {
      headers: { ...headers, Authorization: `Bearer ${res.body.upload_token}` },
      form: form(big, 'big.pdf'),
    });
    expect(up.status).toBe(413);
  });
});
