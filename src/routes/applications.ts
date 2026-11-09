import { createRoute, z } from '@hono/zod-openapi';
import { audit } from '../audit.js';
import { requireScope } from '../auth.js';
import { tenantOf, type Ctx } from '../context.js';
import { withTenant, type Tx } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { body, json, problems, router, security } from '../openapi.js';
import { decodeCursor, page } from '../pagination.js';
import {
  Application,
  ApplicationCreate,
  IdParam,
  PageQuery,
  Pipeline,
  STAGES,
  StageChange,
  StageHistoryEntry,
  listOf,
  type StageName,
} from '../schemas.js';
import { applicationOut, historyOut } from '../serializers.js';
import { checkQuota } from '../quotas.js';
import { processDueDeliveries } from '../webhooks.js';
import { escapeLike } from './jobs.js';

const tags = ['Applications'];
export const applications = router();

const ACTIVE: StageName[] = ['applied', 'screen', 'interview', 'offer'];

/**
 * The pipeline rules. Active stages can move to any other active stage
 * (recruiters skip and step back), offers can be accepted, anything active
 * can be rejected, and hired/rejected are final.
 */
export function allowedMoves(from: StageName): StageName[] {
  if (!ACTIVE.includes(from)) return [];
  return [...ACTIVE.filter((s) => s !== from), ...(from === 'offer' ? (['hired'] as StageName[]) : []), 'rejected'];
}

const APPLICATION_SELECT = (tx: Tx) => tx`
  select a.*, c.first_name as candidate_first_name, c.last_name as candidate_last_name,
         c.email as candidate_email, j.title as job_title
  from hire.applications a
  join hire.candidates c on c.id = a.candidate_id
  join hire.jobs j on j.id = a.job_id`;

function sendWebhooksSoon(c: Ctx) {
  const deps = c.get('deps');
  deps.background(
    processDueDeliveries(deps, { companyId: c.get('principal').companyId, limit: 10 }).catch((err) =>
      console.error('Background webhook delivery failed', err),
    ),
  );
}

applications.openapi(
  createRoute({
    method: 'post',
    path: '/applications',
    tags,
    security,
    summary: 'Apply to a job',
    description:
      'Creates an application in the `applied` stage. Send an existing `candidate_id`, or a `candidate` object: ' +
      'if a candidate with that email already exists in your company they are reused, so one person applying ' +
      'to two jobs stays one candidate.',
    request: body(ApplicationCreate),
    responses: { 201: json(Application, 'The new application'), ...problems(403, 404, 409, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const row = await createApplication(c, c.req.valid('json'));
    return c.json(applicationOut(row), 201);
  },
);

/**
 * Creates an application in Applied for the caller's company, reusing the candidate
 * when the email is already known. Shared by this route and the public apply page.
 */
export async function createApplication(c: Ctx, input: z.infer<typeof ApplicationCreate>) {
  const { sql } = c.get('deps');
  const companyId = c.get('principal').companyId;
  const row = await withTenant(sql, tenantOf(c), async (tx) => {
    const [job] = await tx`select id, status from hire.jobs where id = ${input.job_id}`;
    if (!job) throw notFound('job');
    if (job.status !== 'open')
      throw new ApiError('conflict', `This job is ${job.status} and is not taking applications.`);

    await checkQuota(c, tx, 'applications');
    let candidateId = input.candidate_id;
    if (input.candidate) {
      const cand = input.candidate;
      const [known] = await tx`select id from hire.candidates where lower(email) = lower(${cand.email})`;
      if (!known) await checkQuota(c, tx, 'candidates');
      const [created] = known
        ? []
        : await tx`
        insert into hire.candidates (company_id, first_name, last_name, email, phone, location, linkedin_url,
                                     github_url, source)
        values (${companyId}, ${cand.first_name}, ${cand.last_name}, ${cand.email}, ${cand.phone ?? null},
                ${cand.location ?? null}, ${cand.linkedin_url ?? null}, ${cand.github_url ?? null},
                ${cand.source ?? null})
        on conflict (company_id, lower(email)) do nothing
        returning id`;
      if (created) {
        await audit(c, tx, 'candidate.created', { type: 'candidate', id: created.id });
        candidateId = created.id;
      } else {
        const [existing] = known
          ? [known]
          : await tx`select id from hire.candidates where lower(email) = lower(${cand.email})`;
        candidateId = existing!.id;
        // Someone who applied before without a GitHub link may add one now; an existing link is kept.
        if (cand.github_url) {
          await tx`update hire.candidates set github_url = ${cand.github_url}
                   where id = ${candidateId!} and github_url is null`;
        }
      }
    } else {
      const [existing] = await tx`select id from hire.candidates where id = ${candidateId!}`;
      if (!existing) throw notFound('candidate');
    }

    const [already] = await tx`
      select id from hire.applications where job_id = ${input.job_id} and candidate_id = ${candidateId!}`;
    if (already) {
      throw new ApiError('conflict', 'This candidate has already applied to this job.', { existing_id: already.id });
    }
    await tx`select set_config('app.stage_note', ${input.note ?? ''}, true)`;
    const [app] = await tx`
      insert into hire.applications (company_id, job_id, candidate_id)
      values (${companyId}, ${input.job_id}, ${candidateId!})
      returning id`;
    await audit(c, tx, 'application.created', { type: 'application', id: app!.id }, { job_id: input.job_id });
    const [full] = await tx`${APPLICATION_SELECT(tx)} where a.id = ${app!.id}`;
    return full!;
  });
  sendWebhooksSoon(c);
  return row;
}

const StageList = z
  .string()
  .regex(new RegExp(`^(${STAGES.join('|')})(,(${STAGES.join('|')}))*$`), `Use one or more of: ${STAGES.join(', ')}`)
  .transform((v) => v.split(',') as StageName[])
  .openapi({ type: 'string', example: 'interview,offer', description: 'One stage, or several separated by commas' });

applications.openapi(
  createRoute({
    method: 'get',
    path: '/applications',
    tags,
    security,
    summary: 'Search applications',
    description:
      'Combine filters freely, for example `?job_id=…&stage=interview` for everyone in Interview for one job. ' +
      '`q` matches the candidate name or email.',
    request: {
      query: PageQuery.extend({
        job_id: z.uuid().optional(),
        candidate_id: z.uuid().optional(),
        stage: StageList.optional(),
        q: z.string().trim().min(1).max(100).optional(),
        created_after: z.iso.datetime().optional(),
        created_before: z.iso.datetime().optional(),
      }),
    },
    responses: { 200: json(listOf(Application, 'ApplicationList'), 'A page of applications'), ...problems(422) },
  }),
  async (c) => {
    const query = c.req.valid('query');
    const after = decodeCursor(query.cursor);
    const like = query.q ? `%${escapeLike(query.q)}%` : undefined;
    const { sql } = c.get('deps');
    const rows = await withTenant(
      sql,
      tenantOf(c),
      (tx) => tx`
      ${APPLICATION_SELECT(tx)}
      where true
        ${query.job_id ? tx`and a.job_id = ${query.job_id}` : tx``}
        ${query.candidate_id ? tx`and a.candidate_id = ${query.candidate_id}` : tx``}
        ${query.stage ? tx`and a.stage = any(${query.stage}::hire.stage[])` : tx``}
        ${like ? tx`and (c.first_name || ' ' || c.last_name ilike ${like} or c.email ilike ${like})` : tx``}
        ${query.created_after ? tx`and a.created_at >= ${new Date(query.created_after)}` : tx``}
        ${query.created_before ? tx`and a.created_at < ${new Date(query.created_before)}` : tx``}
        ${after ? tx`and (a.created_at, a.id) < (${after.createdAt}, ${after.id})` : tx``}
      order by a.created_at desc, a.id desc
      limit ${query.limit + 1}`,
    );
    const result = page(rows, query.limit);
    return c.json(
      { object: 'list' as const, data: result.data.map(applicationOut), next_cursor: result.next_cursor },
      200,
    );
  },
);

applications.openapi(
  createRoute({
    method: 'get',
    path: '/applications/{id}',
    tags,
    security,
    summary: 'Get an application',
    request: { params: IdParam },
    responses: { 200: json(Application, 'The application'), ...problems(404, 422) },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { sql } = c.get('deps');
    const [row] = await withTenant(sql, tenantOf(c), (tx) => tx`${APPLICATION_SELECT(tx)} where a.id = ${id}`);
    if (!row) throw notFound('application');
    return c.json(applicationOut(row), 200);
  },
);

applications.openapi(
  createRoute({
    method: 'post',
    path: '/applications/{id}/stage',
    tags,
    security,
    summary: 'Move to another stage',
    description:
      'Active stages (applied, screen, interview, offer) can move to any other active stage. Only an offer can ' +
      'become `hired`. Any active application can be `rejected`. Hired and rejected are final. Every move is ' +
      'saved to the stage history and sent to your webhooks.',
    request: { params: IdParam, ...body(StageChange) },
    responses: { 200: json(Application, 'The application in its new stage'), ...problems(403, 404, 409, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const { sql } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      const [current] = await tx`select stage from hire.applications where id = ${id} for update`;
      if (!current) throw notFound('application');
      const from = current.stage as StageName;
      if (from === input.to) {
        throw new ApiError('invalid_transition', `The application is already in ${from}.`, {
          from,
          to: input.to,
          allowed: allowedMoves(from),
        });
      }
      const allowed = allowedMoves(from);
      if (!allowed.includes(input.to)) {
        const why = allowed.length === 0 ? `${from} is a final stage` : `allowed next stages are ${allowed.join(', ')}`;
        throw new ApiError('invalid_transition', `Can't move from ${from} to ${input.to}: ${why}.`, {
          from,
          to: input.to,
          allowed,
        });
      }
      await tx`select set_config('app.stage_note', ${input.note ?? ''}, true)`;
      await tx`
        update hire.applications
        set stage = ${input.to}, rejection_reason = ${input.to === 'rejected' ? (input.rejection_reason ?? null) : null}
        where id = ${id}`;
      await audit(c, tx, 'application.stage_changed', { type: 'application', id }, { from, to: input.to });
      const [full] = await tx`${APPLICATION_SELECT(tx)} where a.id = ${id}`;
      return full!;
    });
    sendWebhooksSoon(c);
    return c.json(applicationOut(row), 200);
  },
);

applications.openapi(
  createRoute({
    method: 'get',
    path: '/applications/{id}/history',
    tags,
    security,
    summary: 'Stage history',
    description: 'Every stage the application has been in, oldest first, with who moved it and any note.',
    request: { params: IdParam },
    responses: {
      200: json(z.object({ object: z.literal('list'), data: z.array(StageHistoryEntry) }), 'The full history'),
      ...problems(404, 422),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { sql } = c.get('deps');
    const rows = await withTenant(sql, tenantOf(c), async (tx) => {
      const [exists] = await tx`select id from hire.applications where id = ${id}`;
      if (!exists) throw notFound('application');
      return tx`select * from hire.stage_history where application_id = ${id} order by id limit 1000`;
    });
    return c.json({ object: 'list' as const, data: rows.map(historyOut) }, 200);
  },
);

applications.openapi(
  createRoute({
    method: 'get',
    path: '/pipeline',
    tags,
    security,
    summary: 'Pipeline counts',
    description: 'How many applications sit in each stage, for one job or across all jobs.',
    request: { query: z.object({ job_id: z.uuid().optional() }) },
    responses: { 200: json(Pipeline, 'Counts per stage'), ...problems(422) },
  }),
  async (c) => {
    const { job_id } = c.req.valid('query');
    const { sql } = c.get('deps');
    const rows = await withTenant(
      sql,
      tenantOf(c),
      (tx) => tx<{ stage: StageName; n: number }[]>`
      select stage, count(*) as n from hire.applications
      where true ${job_id ? tx`and job_id = ${job_id}` : tx``}
      group by stage`,
    );
    const stages = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<StageName, number>;
    for (const r of rows) stages[r.stage] = r.n;
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    return c.json({ object: 'pipeline' as const, job_id: job_id ?? null, total, stages }, 200);
  },
);
