import { createHmac } from 'node:crypto';
import { createRoute } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { jwtVerify, SignJWT } from 'jose';
import { hitRateLimit, setRateLimitHeaders } from '../auth.js';
import { isBotRequest } from '../bots.js';
import { clientNetwork, PLAN_LIMITS, type Ctx, type Plan } from '../context.js';
import { ApiError } from '../errors.js';
import { body, json, publicProblems, router } from '../openapi.js';
import { SANDBOX_QUOTAS } from '../quotas.js';
import {
  IdParam,
  Project,
  ProjectUpload,
  PublicApplication,
  PublicApplicationReceipt,
  PublicJob,
  Resume,
  ResumeUpload,
} from '../schemas.js';
import { projectOut, resumeOut } from '../serializers.js';
import { createApplication } from './applications.js';
import { createProject, storeProjectFile } from './projects.js';
import { storeResume } from './resumes.js';

// The apply page: what a candidate sees when an employer shares a job's link.
// No API key: a job's id is enough to read it and apply to it while it's open.
// Applying is guarded by bot protection and per-network limits, and hands back a
// short-lived token that can send one résumé and one project file, nothing else.

const tags = ['Apply page'];
export const publicRoutes = router();

const READS_PER_MINUTE = 120;
const APPLICATIONS_PER_HOUR = 10;
const UPLOADS_PER_HOUR = 30;
const TOKEN_MINUTES = 30;
const TOKEN_AUDIENCE = 'meridian-hire:upload';

/** Who is acting when a candidate applies: shown as "apply page" in histories and the audit log. */
function actAsApplicant(c: Ctx, companyId: string, plan: Plan) {
  c.set('principal', { type: 'public', id: 'apply_page', companyId, plan, scopes: ['write'] });
}

async function limitNetwork(c: Ctx, bucket: string, windowSeconds: number, limit: number, message: string) {
  const result = await hitRateLimit(c.get('deps').sql, `public:${bucket}:${clientNetwork(c)}`, windowSeconds, limit);
  setRateLimitHeaders(c, limit, result);
  if (result.exceeded) throw new ApiError('rate_limited', message, { retry_after: result.resetSeconds });
}

/** Applications count against the company's own request budget and sandbox caps, like any other write. */
async function limitCompany(c: Ctx, companyId: string, plan: Plan) {
  const { sql } = c.get('deps');
  const perMinute = await hitRateLimit(sql, `company:${companyId}`, 60, PLAN_LIMITS[plan].requestsPerMinute);
  if (perMinute.exceeded) {
    throw new ApiError('rate_limited', 'This employer is getting a lot of applications right now. Try again shortly.', {
      retry_after: perMinute.resetSeconds,
    });
  }
  if (plan === 'sandbox') {
    const writes = await hitRateLimit(sql, `company:${companyId}:writes`, 86400, SANDBOX_QUOTAS.writesPerDay);
    if (writes.exceeded)
      throw new ApiError('rate_limited', 'This demo has had its changes for today.', {
        retry_after: writes.resetSeconds,
      });
  }
}

type JobRow = {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employment_type: string;
  remote: boolean;
  description: string | null;
  status: string;
  company_id: string;
  company_name: string;
  plan: Plan;
};

/** Open and closed jobs of live companies; drafts and expired sandboxes don't exist to the public. */
async function findJob(c: Ctx, id: string): Promise<JobRow> {
  const [job] = await c.get('deps').sql<JobRow[]>`
    select j.id, j.title, j.department, j.location, j.employment_type, j.remote, j.description, j.status,
           j.company_id, co.name as company_name, co.plan
    from hire.jobs j join hire.companies co on co.id = j.company_id
    where j.id = ${id} and j.status in ('open', 'closed')
      and (co.expires_at is null or co.expires_at > now())`;
  if (!job) throw new ApiError('not_found', 'This job link is not valid, or the job has been taken down.');
  return job;
}

function tokenKey(c: Ctx) {
  return createHmac('sha256', c.get('deps').config.encryptionKey).update('meridian-hire upload token v1').digest();
}

async function issueUploadToken(c: Ctx, claims: { company: string; candidate: string; project: string | null }) {
  const expiresAt = new Date(Date.now() + TOKEN_MINUTES * 60_000);
  const token = await new SignJWT({ cid: claims.company, prj: claims.project })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.candidate)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(tokenKey(c));
  return { token, expiresAt };
}

/** Checks the upload token and acts as the applicant for its company. */
async function applicantFromToken(c: Ctx) {
  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (!token) throw new ApiError('unauthorized', 'Send the upload_token from your application as a bearer token.');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, tokenKey(c), { audience: TOKEN_AUDIENCE, algorithms: ['HS256'] }));
  } catch {
    throw new ApiError('unauthorized', 'This upload link has expired. Your application was still sent.');
  }
  const companyId = String(payload.cid);
  const [company] = await c.get('deps').sql<{ plan: Plan }[]>`
    select plan from hire.companies where id = ${companyId} and (expires_at is null or expires_at > now())`;
  if (!company) throw new ApiError('unauthorized', 'This upload link is no longer valid.');
  actAsApplicant(c, companyId, company.plan);
  await limitNetwork(c, 'uploads', 3600, UPLOADS_PER_HOUR, 'Too many uploads from your network. Try again later.');
  return {
    candidateId: String(payload.sub),
    projectId: typeof payload.prj === 'string' ? payload.prj : null,
    issuedAt: new Date((payload.iat ?? 0) * 1000),
  };
}

publicRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/public/jobs/{id}',
    tags,
    summary: 'Read a job for its apply page',
    description: 'No key needed. Returns what a candidate needs to see before applying. Drafts are not shown.',
    request: { params: IdParam },
    responses: { 200: json(PublicJob, 'The job'), ...publicProblems(404, 422) },
  }),
  async (c) => {
    await limitNetwork(c, 'reads', 60, READS_PER_MINUTE, 'Too many requests. Try again in a minute.');
    const job = await findJob(c, c.req.valid('param').id);
    return c.json(
      {
        id: job.id,
        object: 'public_job' as const,
        title: job.title,
        department: job.department,
        location: job.location,
        employment_type: job.employment_type as 'full_time',
        remote: job.remote,
        description: job.description,
        company: { name: job.company_name, sandbox: job.plan === 'sandbox' },
        accepting_applications: job.status === 'open',
      },
      200,
    );
  },
);

publicRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/public/jobs/{id}/applications',
    tags,
    summary: 'Apply to a job',
    description:
      'No key needed: this is what the apply page sends. Creates the application in Applied, with the GitHub ' +
      'profile and project if given, and returns an `upload_token` for sending the résumé and project file ' +
      'next. An email that has applied before is matched to the same person (emails are not verified). On ' +
      'the live demo this only works from a browser (bot protection).',
    request: { params: IdParam, ...body(PublicApplication) },
    responses: { 201: json(PublicApplicationReceipt, 'Application sent'), ...publicProblems(403, 404, 409, 422) },
  }),
  async (c) => {
    if (await isBotRequest(c)) {
      throw new ApiError(
        'forbidden',
        "We couldn't confirm this came from a regular web browser, so the application wasn't sent. Please try " +
          'again, with ad- and script-blocking extensions turned off for this page.',
      );
    }
    await limitNetwork(
      c,
      'applications',
      3600,
      APPLICATIONS_PER_HOUR,
      'Too many applications from your network in the last hour. Try again later.',
    );
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const job = await findJob(c, id);
    if (job.status !== 'open') throw new ApiError('conflict', 'This job has closed and is not taking applications.');
    await limitCompany(c, job.company_id, job.plan);
    actAsApplicant(c, job.company_id, job.plan);

    let app;
    try {
      app = await createApplication(c, {
        job_id: job.id,
        candidate: { ...input.candidate, source: 'careers_page' },
        note: input.message ?? null,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict' && err.extra.existing_id) {
        throw new ApiError('conflict', "You've already applied to this job with this email.");
      }
      throw err;
    }
    const project = input.project ? await createProject(c, app.candidate_id, input.project) : null;
    const upload = await issueUploadToken(c, {
      company: job.company_id,
      candidate: app.candidate_id,
      project: project?.id ?? null,
    });
    return c.json(
      {
        object: 'public_application' as const,
        application_id: app.id as string,
        project_id: (project?.id as string | undefined) ?? null,
        job_title: job.title,
        company_name: job.company_name,
        upload_token: upload.token,
        upload_token_expires_at: upload.expiresAt.toISOString(),
      },
      201,
    );
  },
);

// Uploads have the largest paid-plan limit here; each upload then checks the employer's own plan.
const uploadLimit = bodyLimit({
  maxSize: 4 * 1024 * 1024 + 64 * 1024,
  onError: () => {
    throw new ApiError('payload_too_large', 'That file is too big.');
  },
});
publicRoutes.post('/public/uploads/resume', uploadLimit);
publicRoutes.post('/public/uploads/project-file', uploadLimit);

publicRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/public/uploads/resume',
    tags,
    security: [{ uploadToken: [] }],
    summary: 'Send the résumé for an application',
    description: 'Multipart form data with a `file` field (PDF or Word). One résumé per application.',
    request: { body: { content: { 'multipart/form-data': { schema: ResumeUpload } }, required: true } },
    responses: { 201: json(Resume, 'Stored'), ...publicProblems(401, 409, 413, 415, 422) },
  }),
  async (c) => {
    const applicant = await applicantFromToken(c);
    const { file } = c.req.valid('form') as { file?: unknown };
    const row = await storeResume(c, applicant.candidateId, file, { onlyOneSince: applicant.issuedAt });
    return c.json(resumeOut(row), 201);
  },
);

publicRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/public/uploads/project-file',
    tags,
    security: [{ uploadToken: [] }],
    summary: "Send the project's file",
    description:
      'Multipart form data with a `file` field: a ZIP of the code, a PDF, or a PNG or JPEG. Only for the project ' +
      'sent with the application, and only once.',
    request: { body: { content: { 'multipart/form-data': { schema: ProjectUpload } }, required: true } },
    responses: { 200: json(Project, 'Stored'), ...publicProblems(401, 409, 413, 415, 422) },
  }),
  async (c) => {
    const applicant = await applicantFromToken(c);
    if (!applicant.projectId) {
      throw new ApiError('conflict', 'No project was sent with this application, so there is nothing to attach to.');
    }
    const { file } = c.req.valid('form') as { file?: unknown };
    const row = await storeProjectFile(c, applicant.projectId, file, { onlyIfEmpty: true });
    return c.json(projectOut(row), 200);
  },
);
