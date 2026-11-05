import { createRoute, z } from '@hono/zod-openapi';
import { audit } from '../audit.js';
import { requireScope } from '../auth.js';
import { tenantOf } from '../context.js';
import { withTenant } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { removeFiles } from '../maintenance.js';
import { body, json, problems, router, security } from '../openapi.js';
import { decodeCursor, page } from '../pagination.js';
import { Candidate, CandidateCreate, CandidateUpdate, IdParam, PageQuery, listOf } from '../schemas.js';
import { candidateOut } from '../serializers.js';
import { checkQuota } from '../quotas.js';
import { escapeLike } from './jobs.js';

const tags = ['Candidates'];
export const candidates = router();

candidates.openapi(
  createRoute({
    method: 'post',
    path: '/candidates',
    tags,
    security,
    summary: 'Add a candidate',
    description: 'Emails are unique within a company. Adding the same email twice returns 409 with the existing id.',
    request: body(CandidateCreate),
    responses: { 201: json(Candidate, 'The new candidate'), ...problems(403, 409, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const input = c.req.valid('json');
    const { sql } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      await checkQuota(c, tx, 'candidates');
      const [candidate] = await tx`
        insert into hire.candidates (company_id, first_name, last_name, email, phone, location, linkedin_url, source)
        values (${c.get('principal').companyId}, ${input.first_name}, ${input.last_name}, ${input.email},
                ${input.phone ?? null}, ${input.location ?? null}, ${input.linkedin_url ?? null}, ${input.source ?? null})
        on conflict (company_id, lower(email)) do nothing
        returning *`;
      if (!candidate) {
        const [existing] = await tx`select id from hire.candidates where lower(email) = ${input.email}`;
        throw new ApiError('conflict', 'A candidate with this email already exists.', { existing_id: existing?.id });
      }
      await audit(c, tx, 'candidate.created', { type: 'candidate', id: candidate.id });
      return candidate;
    });
    return c.json(candidateOut(row), 201);
  },
);

candidates.openapi(
  createRoute({
    method: 'get',
    path: '/candidates',
    tags,
    security,
    summary: 'List candidates',
    description: 'Search by name or email with `q`, or look one up by exact `email`.',
    request: {
      query: PageQuery.extend({
        q: z.string().trim().min(1).max(100).optional().openapi({ example: 'avery' }),
        email: z.email().optional(),
      }),
    },
    responses: { 200: json(listOf(Candidate, 'CandidateList'), 'A page of candidates'), ...problems(422) },
  }),
  async (c) => {
    const { limit, cursor, q, email } = c.req.valid('query');
    const after = decodeCursor(cursor);
    const { sql } = c.get('deps');
    const like = q ? `%${escapeLike(q)}%` : undefined;
    const rows = await withTenant(
      sql,
      tenantOf(c),
      (tx) => tx`
      select * from hire.candidates
      where true
        ${email ? tx`and lower(email) = ${email.toLowerCase()}` : tx``}
        ${like ? tx`and (first_name || ' ' || last_name ilike ${like} or email ilike ${like})` : tx``}
        ${after ? tx`and (created_at, id) < (${after.createdAt}, ${after.id})` : tx``}
      order by created_at desc, id desc
      limit ${limit + 1}`,
    );
    const result = page(rows, limit);
    return c.json(
      { object: 'list' as const, data: result.data.map(candidateOut), next_cursor: result.next_cursor },
      200,
    );
  },
);

candidates.openapi(
  createRoute({
    method: 'get',
    path: '/candidates/{id}',
    tags,
    security,
    summary: 'Get a candidate',
    request: { params: IdParam },
    responses: { 200: json(Candidate, 'The candidate'), ...problems(404, 422) },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { sql } = c.get('deps');
    const [row] = await withTenant(sql, tenantOf(c), (tx) => tx`select * from hire.candidates where id = ${id}`);
    if (!row) throw notFound('candidate');
    return c.json(candidateOut(row), 200);
  },
);

candidates.openapi(
  createRoute({
    method: 'patch',
    path: '/candidates/{id}',
    tags,
    security,
    summary: 'Update a candidate',
    request: { params: IdParam, ...body(CandidateUpdate) },
    responses: { 200: json(Candidate, 'The updated candidate'), ...problems(403, 404, 409, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const { sql } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      const [candidate] = await tx`
        update hire.candidates set ${tx(input as Record<string, unknown>)} where id = ${id} returning *`;
      if (!candidate) throw notFound('candidate');
      await audit(c, tx, 'candidate.updated', { type: 'candidate', id }, { fields: Object.keys(input) });
      return candidate;
    });
    return c.json(candidateOut(row), 200);
  },
);

candidates.openapi(
  createRoute({
    method: 'delete',
    path: '/candidates/{id}',
    tags,
    security,
    summary: 'Erase a candidate',
    description:
      'Permanently deletes the candidate, their applications, stage history, résumé files and the webhook deliveries about them. Use this for ' +
      'privacy deletion requests. The audit log keeps a record that an erasure happened, without personal data.',
    request: { params: IdParam },
    responses: { 204: { description: 'Erased' }, ...problems(403, 404, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const { sql, storage } = c.get('deps');
    const paths = await withTenant(sql, tenantOf(c), async (tx) => {
      const [candidate] = await tx`select id from hire.candidates where id = ${id} for update`;
      if (!candidate) throw notFound('candidate');
      const files = await tx<
        { storage_path: string }[]
      >`select storage_path from hire.resumes where candidate_id = ${id}`;
      const [{ applications }] = (await tx`
        select count(*) as applications from hire.applications where candidate_id = ${id}`) as unknown as [
        { applications: number },
      ];
      await tx`delete from hire.candidates where id = ${id}`;
      // Queue the files in the same transaction, so they are cleaned up even if
      // the storage call below fails (the maintenance job retries the queue).
      if (files.length > 0) {
        await tx`insert into hire.pending_file_deletions ${tx(
          files.map((f) => ({ storage_path: f.storage_path, company_id: c.get('principal').companyId })),
        )}`;
      }
      await audit(
        c,
        tx,
        'candidate.erased',
        { type: 'candidate', id },
        {
          applications_deleted: applications,
          resumes_deleted: files.length,
        },
      );
      return files.map((f) => f.storage_path);
    });
    // Delivery payloads can carry the recruiter's note, so they go too. The API role can only
    // read deliveries; this runs as the app login, scoped to the caller's company.
    await sql`
      delete from hire.webhook_deliveries
      where company_id = ${c.get('principal').companyId} and payload->'data'->>'candidate_id' = ${id}`;
    await removeFiles({ sql, storage }, paths);
    return c.body(null, 204);
  },
);
