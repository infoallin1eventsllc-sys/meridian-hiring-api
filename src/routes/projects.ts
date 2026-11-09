import { randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { audit } from '../audit.js';
import { requireScope } from '../auth.js';
import { tenantOf, type Ctx } from '../context.js';
import { sha256Hex } from '../crypto.js';
import { withTenant } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { removeFiles } from '../maintenance.js';
import { body, json, problems, router, security } from '../openapi.js';
import { DownloadLink, IdParam, Project, ProjectCreate, ProjectUpdate, ProjectUpload } from '../schemas.js';
import { projectOut } from '../serializers.js';
import { checkFileBytes, checkQuota } from '../quotas.js';
import { cleanFileName } from './resumes.js';

// Projects let a candidate show real work: a GitHub repository, a live link and
// an optional file (a ZIP of the code, a PDF case study or a screenshot).

const tags = ['Projects'];
export const projects = router();

// Vercel caps request bodies at 4.5 MB, so bigger work belongs on GitHub.
const MAX_BYTES = 4 * 1024 * 1024;
const SANDBOX_MAX_BYTES = 2 * 1024 * 1024;
const LINK_SECONDS = 300;

// As with résumés, the file's first bytes decide its type, never its name.
function sniff(bytes: Uint8Array): { contentType: string; ext: string } | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return { contentType: 'application/pdf', ext: 'pdf' };
  if (starts(0x50, 0x4b, 0x03, 0x04)) return { contentType: 'application/zip', ext: 'zip' };
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { contentType: 'image/png', ext: 'png' };
  if (starts(0xff, 0xd8, 0xff)) return { contentType: 'image/jpeg', ext: 'jpg' };
  return undefined;
}

projects.openapi(
  createRoute({
    method: 'post',
    path: '/candidates/{id}/projects',
    tags,
    security,
    summary: 'Add a project',
    description:
      'Something the candidate built: a title, what it is, the GitHub repository and where it runs. Attach a file ' +
      'afterwards with POST /v1/projects/{id}/file.',
    request: { params: IdParam, ...body(ProjectCreate) },
    responses: { 201: json(Project, 'The new project'), ...problems(403, 404, 409, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    return c.json(projectOut(await createProject(c, id, c.req.valid('json'))), 201);
  },
);

/** Adds a project to a candidate in the caller's company. Shared with the public apply page. */
export async function createProject(c: Ctx, candidateId: string, input: z.infer<typeof ProjectCreate>) {
  const { sql } = c.get('deps');
  return withTenant(sql, tenantOf(c), async (tx) => {
    const [candidate] = await tx`select id from hire.candidates where id = ${candidateId}`;
    if (!candidate) throw notFound('candidate');
    await checkQuota(c, tx, 'projects');
    const [project] = await tx`
      insert into hire.projects (company_id, candidate_id, title, description, repo_url, live_url)
      values (${c.get('principal').companyId}, ${candidateId}, ${input.title}, ${input.description ?? null},
              ${input.repo_url ?? null}, ${input.live_url ?? null})
      returning *`;
    await audit(c, tx, 'project.added', { type: 'project', id: project!.id }, { candidate_id: candidateId });
    return project!;
  });
}

projects.openapi(
  createRoute({
    method: 'get',
    path: '/candidates/{id}/projects',
    tags,
    security,
    summary: "List a candidate's projects",
    request: { params: IdParam },
    responses: {
      200: json(z.object({ object: z.literal('list'), data: z.array(Project) }), 'Newest first'),
      ...problems(404, 422),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { sql } = c.get('deps');
    const rows = await withTenant(sql, tenantOf(c), async (tx) => {
      const [candidate] = await tx`select id from hire.candidates where id = ${id}`;
      if (!candidate) throw notFound('candidate');
      return tx`select * from hire.projects where candidate_id = ${id} order by created_at desc, id desc limit 100`;
    });
    return c.json({ object: 'list' as const, data: rows.map(projectOut) }, 200);
  },
);

projects.openapi(
  createRoute({
    method: 'patch',
    path: '/projects/{id}',
    tags,
    security,
    summary: 'Update a project',
    request: { params: IdParam, ...body(ProjectUpdate) },
    responses: { 200: json(Project, 'The updated project'), ...problems(403, 404, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const { sql } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      const [project] = await tx`
        update hire.projects set ${tx(input as Record<string, unknown>)} where id = ${id} returning *`;
      if (!project) throw notFound('project');
      await audit(c, tx, 'project.updated', { type: 'project', id }, { fields: Object.keys(input) });
      return project;
    });
    return c.json(projectOut(row), 200);
  },
);

// Refuse oversized uploads before reading them, using the limit for this plan.
projects.post('/projects/:id/file', (c, next) =>
  bodyLimit({
    maxSize: (c.get('principal').plan === 'sandbox' ? SANDBOX_MAX_BYTES : MAX_BYTES) + 64 * 1024,
    onError: () => {
      throw new ApiError('payload_too_large', 'That file is over the size limit for project files.');
    },
  })(c, next),
);

projects.openapi(
  createRoute({
    method: 'post',
    path: '/projects/{id}/file',
    tags,
    security,
    summary: 'Attach a file to a project',
    description:
      'Send the file as multipart form data in a field named `file`: a ZIP of the code, a PDF, or a PNG or JPEG ' +
      'screenshot, up to 4 MB (2 MB in a sandbox). Replaces any file the project already has. ZIP files are stored ' +
      'as they are and never unpacked or run.',
    request: {
      params: IdParam,
      body: { content: { 'multipart/form-data': { schema: ProjectUpload } }, required: true },
    },
    responses: { 200: json(Project, 'The project with its file'), ...problems(403, 404, 409, 413, 415, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const { file } = c.req.valid('form') as { file?: unknown };
    return c.json(projectOut(await storeProjectFile(c, id, file)), 200);
  },
);

/**
 * Checks and stores a project's file, replacing any earlier one. `onlyIfEmpty` (used by
 * the public apply page) refuses to replace a file that is already there.
 */
export async function storeProjectFile(c: Ctx, id: string, file: unknown, opts: { onlyIfEmpty?: boolean } = {}) {
  if (!(file instanceof File)) {
    throw new ApiError('validation_failed', 'Attach the project file in a form field named "file".', {
      errors: [{ path: 'file', message: 'Required file' }],
    });
  }
  const principal = c.get('principal');
  const limit = principal.plan === 'sandbox' ? SANDBOX_MAX_BYTES : MAX_BYTES;
  if (file.size === 0)
    throw new ApiError('validation_failed', 'The file is empty.', {
      errors: [{ path: 'file', message: 'Empty file' }],
    });
  if (file.size > limit)
    throw new ApiError(
      'payload_too_large',
      `Project files can be up to ${limit / 1024 / 1024} MB here. Link bigger projects on GitHub.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) throw new ApiError('unsupported_media_type', 'Upload a ZIP of the code, a PDF, or a PNG or JPEG image.');

  const { sql, storage } = c.get('deps');
  const tenant = tenantOf(c);
  const candidateId = await withTenant(sql, tenant, async (tx) => {
    const [project] = await tx`select candidate_id, size_bytes from hire.projects where id = ${id}`;
    if (!project) throw notFound('project');
    if (opts.onlyIfEmpty && project.size_bytes !== null)
      throw new ApiError('conflict', 'A file was already sent with this project.');
    await checkFileBytes(c, tx, bytes.byteLength - (project.size_bytes ?? 0));
    return project.candidate_id as string;
  });

  // Random object names: knowing a project id never reveals where its file is.
  const storagePath = `${principal.companyId}/${candidateId}/projects/${randomUUID()}.${kind.ext}`;
  await storage.put(storagePath, bytes, kind.contentType);
  let replaced = null as string | null;
  try {
    const row = await withTenant(sql, tenant, async (tx) => {
      const [current] = await tx`select storage_path, size_bytes from hire.projects where id = ${id} for update`;
      if (!current) throw notFound('project');
      // Checked again here: other uploads may have finished while this file was being stored.
      await checkFileBytes(c, tx, bytes.byteLength - (current.size_bytes ?? 0));
      const [project] = await tx`
        update hire.projects
        set storage_path = ${storagePath}, file_name = ${cleanFileName(file.name, kind.ext, 'project')},
            content_type = ${kind.contentType}, size_bytes = ${bytes.byteLength}, sha256 = ${sha256Hex(bytes)}
        where id = ${id}
        returning *`;
      if (current.storage_path) {
        replaced = current.storage_path as string;
        await tx`insert into hire.pending_file_deletions (storage_path, company_id)
                 values (${replaced}, ${principal.companyId})`;
      }
      await audit(
        c,
        tx,
        'project.file_uploaded',
        { type: 'project', id },
        { candidate_id: candidateId, size_bytes: bytes.byteLength },
      );
      return project!;
    });
    if (replaced) await removeFiles({ sql, storage }, [replaced]);
    return row;
  } catch (err) {
    // The project or candidate may have been deleted mid-upload; don't leave the file behind.
    await storage.remove([storagePath]).catch(() => {});
    throw err;
  }
}

projects.openapi(
  createRoute({
    method: 'get',
    path: '/projects/{id}/download',
    tags,
    security,
    summary: "Get a download link for a project's file",
    description: 'Returns a private link to the file that expires after five minutes.',
    request: { params: IdParam },
    responses: { 200: json(DownloadLink, 'A short-lived link'), ...problems(404, 422) },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { sql, storage } = c.get('deps');
    const path = await withTenant(sql, tenantOf(c), async (tx) => {
      const [project] = await tx`select storage_path from hire.projects where id = ${id}`;
      if (!project) throw notFound('project');
      if (!project.storage_path)
        throw new ApiError('not_found', 'This project has no file. Its links are in repo_url and live_url.');
      await audit(c, tx, 'project.file_downloaded', { type: 'project', id });
      return project.storage_path as string;
    });
    const url = await storage.signedUrl(path, LINK_SECONDS);
    return c.json({ url, expires_at: new Date(Date.now() + LINK_SECONDS * 1000).toISOString() }, 200);
  },
);

projects.openapi(
  createRoute({
    method: 'delete',
    path: '/projects/{id}',
    tags,
    security,
    summary: 'Delete a project',
    description: 'Deletes the project and its file.',
    request: { params: IdParam },
    responses: { 204: { description: 'Deleted' }, ...problems(403, 404, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const { sql, storage } = c.get('deps');
    const path = await withTenant(sql, tenantOf(c), async (tx) => {
      const [project] = await tx`delete from hire.projects where id = ${id} returning storage_path, candidate_id`;
      if (!project) throw notFound('project');
      if (project.storage_path) {
        await tx`insert into hire.pending_file_deletions (storage_path, company_id)
                 values (${project.storage_path}, ${c.get('principal').companyId})`;
      }
      await audit(c, tx, 'project.deleted', { type: 'project', id }, { candidate_id: project.candidate_id });
      return project.storage_path as string | null;
    });
    if (path) await removeFiles({ sql, storage }, [path]);
    return c.body(null, 204);
  },
);
