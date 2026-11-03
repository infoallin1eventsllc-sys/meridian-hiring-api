import { createRoute, z } from '@hono/zod-openapi';
import { audit } from '../audit.js';
import { requireScope } from '../auth.js';
import { tenantOf } from '../context.js';
import { withTenant } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { body, json, problems, router, security } from '../openapi.js';
import { decodeCursor, page } from '../pagination.js';
import { IdParam, Job, JobCreate, JobStatus, JobUpdate, PageQuery, listOf } from '../schemas.js';
import { jobOut } from '../serializers.js';
import { checkQuota } from '../quotas.js';

const tags = ['Jobs'];
export const jobs = router();

jobs.openapi(
  createRoute({
    method: 'post',
    path: '/jobs',
    tags,
    security,
    summary: 'Post a job',
    request: body(JobCreate),
    responses: { 201: json(Job, 'The new job'), ...problems(403, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const input = c.req.valid('json');
    const { sql } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      await checkQuota(c, tx, 'jobs');
      const [job] = await tx`
        insert into hire.jobs (company_id, title, department, location, employment_type, remote, description, status)
        values (${c.get('principal').companyId}, ${input.title}, ${input.department ?? null}, ${input.location ?? null},
                ${input.employment_type ?? 'full_time'}, ${input.remote ?? false}, ${input.description ?? null},
                ${input.status ?? 'open'})
        returning *`;
      await audit(c, tx, 'job.created', { type: 'job', id: job!.id }, { title: input.title });
      return job!;
    });
    return c.json(jobOut(row), 201);
  },
);

jobs.openapi(
  createRoute({
    method: 'get',
    path: '/jobs',
    tags,
    security,
    summary: 'List jobs',
    description: 'Newest first. Filter by status, or search titles, departments and locations with `q`.',
    request: {
      query: PageQuery.extend({
        status: JobStatus.optional(),
        q: z.string().trim().min(1).max(100).optional().openapi({ example: 'designer' }),
      }),
    },
    responses: { 200: json(listOf(Job, 'JobList'), 'A page of jobs'), ...problems(422) },
  }),
  async (c) => {
    const { limit, cursor, status, q } = c.req.valid('query');
    const after = decodeCursor(cursor);
    const { sql } = c.get('deps');
    const rows = await withTenant(
      sql,
      tenantOf(c),
      (tx) => tx`
      select * from hire.jobs
      where true
        ${status ? tx`and status = ${status}` : tx``}
        ${q ? tx`and (title ilike ${`%${escapeLike(q)}%`} or department ilike ${`%${escapeLike(q)}%`} or location ilike ${`%${escapeLike(q)}%`})` : tx``}
        ${after ? tx`and (created_at, id) < (${after.createdAt}, ${after.id})` : tx``}
      order by created_at desc, id desc
      limit ${limit + 1}`,
    );
    const result = page(rows, limit);
    return c.json({ object: 'list' as const, data: result.data.map(jobOut), next_cursor: result.next_cursor }, 200);
  },
);

jobs.openapi(
  createRoute({
    method: 'get',
    path: '/jobs/{id}',
    tags,
    security,
    summary: 'Get a job',
    request: { params: IdParam },
    responses: { 200: json(Job, 'The job'), ...problems(404, 422) },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { sql } = c.get('deps');
    const [row] = await withTenant(sql, tenantOf(c), (tx) => tx`select * from hire.jobs where id = ${id}`);
    if (!row) throw notFound('job');
    return c.json(jobOut(row), 200);
  },
);

jobs.openapi(
  createRoute({
    method: 'patch',
    path: '/jobs/{id}',
    tags,
    security,
    summary: 'Update a job',
    description: 'Send only the fields to change. Set `status` to `closed` to stop taking applications.',
    request: { params: IdParam, ...body(JobUpdate) },
    responses: { 200: json(Job, 'The updated job'), ...problems(403, 404, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const { sql } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      const [job] = await tx`update hire.jobs set ${tx(input as Record<string, unknown>)} where id = ${id} returning *`;
      if (!job) throw notFound('job');
      await audit(c, tx, 'job.updated', { type: 'job', id }, { fields: Object.keys(input) });
      return job;
    });
    return c.json(jobOut(row), 200);
  },
);

jobs.openapi(
  createRoute({
    method: 'delete',
    path: '/jobs/{id}',
    tags,
    security,
    summary: 'Delete a job',
    description: 'Only jobs without applications can be deleted. Close a job instead to keep its history.',
    request: { params: IdParam },
    responses: { 204: { description: 'Deleted' }, ...problems(403, 404, 409, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const { sql } = c.get('deps');
    await withTenant(sql, tenantOf(c), async (tx) => {
      const [job] = await tx`
        select j.id, (select count(*) from hire.applications a where a.job_id = j.id) as applications
        from hire.jobs j where j.id = ${id} for update`;
      if (!job) throw notFound('job');
      if (job.applications > 0) {
        throw new ApiError(
          'conflict',
          `This job has ${job.applications} application(s). Close it instead of deleting it.`,
        );
      }
      await tx`delete from hire.jobs where id = ${id}`;
      await audit(c, tx, 'job.deleted', { type: 'job', id });
    });
    return c.body(null, 204);
  },
);

export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
