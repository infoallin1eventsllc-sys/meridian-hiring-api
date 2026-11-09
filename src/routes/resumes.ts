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
import { json, problems, router, security } from '../openapi.js';
import { DownloadLink, IdParam, Resume, ResumeUpload } from '../schemas.js';
import { resumeOut } from '../serializers.js';
import { checkQuota, checkFileBytes } from '../quotas.js';

const tags = ['Résumés'];
export const resumes = router();

const MAX_BYTES = 4 * 1024 * 1024;
const SANDBOX_MAX_BYTES = 1024 * 1024;
const LINK_SECONDS = 300;

// The file's first bytes decide its type; the name and the browser's claimed
// type are not trusted.
function sniff(bytes: Uint8Array): { contentType: string; ext: string } | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return { contentType: 'application/pdf', ext: 'pdf' };
  // A .docx is a zip whose entries live under word/; any other zip is refused.
  if (
    starts(0x50, 0x4b, 0x03, 0x04) &&
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('word/')
  ) {
    return { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
  }
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return { contentType: 'application/msword', ext: 'doc' };
  return undefined;
}

export function cleanFileName(name: string, ext: string, fallback = 'resume') {
  const base =
    (name.split(/[\\/]/).pop() ?? '')
      .replace(/\.[^.]*$/, '')
      .replace(/[^\p{L}\p{N} ._-]+/gu, '')
      .trim()
      .slice(0, 120) || fallback;
  return `${base}.${ext}`;
}

// Refuse oversized uploads before reading them, using the limit for this plan.
resumes.post('/candidates/:id/resumes', (c, next) =>
  bodyLimit({
    maxSize: (c.get('principal').plan === 'sandbox' ? SANDBOX_MAX_BYTES : MAX_BYTES) + 64 * 1024,
    onError: () => {
      throw new ApiError('payload_too_large', 'That file is over the size limit for résumés.');
    },
  })(c, next),
);

resumes.openapi(
  createRoute({
    method: 'post',
    path: '/candidates/{id}/resumes',
    tags,
    security,
    summary: 'Upload a résumé',
    description:
      'Send the file as multipart form data in a field named `file`. PDF, DOCX or DOC, up to 4 MB (1 MB in a sandbox).',
    request: {
      params: IdParam,
      body: { content: { 'multipart/form-data': { schema: ResumeUpload } }, required: true },
    },
    responses: { 201: json(Resume, 'The stored résumé'), ...problems(403, 404, 409, 413, 415, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const { file } = c.req.valid('form') as { file?: unknown };
    return c.json(resumeOut(await storeResume(c, id, file)), 201);
  },
);

/**
 * Checks and stores a résumé for a candidate in the caller's company. `onlyOneSince`
 * (used by the public apply page) refuses a second résumé sent after that moment.
 */
export async function storeResume(c: Ctx, id: string, file: unknown, opts: { onlyOneSince?: Date } = {}) {
  if (!(file instanceof File)) {
    throw new ApiError('validation_failed', 'Attach the résumé in a form field named "file".', {
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
    throw new ApiError('payload_too_large', `Résumés can be up to ${limit / 1024 / 1024} MB here.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) throw new ApiError('unsupported_media_type', 'Upload a PDF or Word document (.pdf, .docx or .doc).');

  const { sql, storage } = c.get('deps');
  const tenant = tenantOf(c);
  await withTenant(sql, tenant, async (tx) => {
    const [candidate] = await tx`select id from hire.candidates where id = ${id}`;
    if (!candidate) throw notFound('candidate');
    if (opts.onlyOneSince) {
      const [sent] = await tx`
        select 1 from hire.resumes where candidate_id = ${id} and created_at >= ${opts.onlyOneSince}`;
      if (sent) throw new ApiError('conflict', 'A résumé was already sent with this application.');
    }
    await checkQuota(c, tx, 'resumes');
    await checkFileBytes(c, tx, bytes.byteLength);
  });

  // Random object names: knowing a candidate id never reveals where files are.
  const storagePath = `${principal.companyId}/${id}/${randomUUID()}.${kind.ext}`;
  await storage.put(storagePath, bytes, kind.contentType);
  try {
    const row = await withTenant(sql, tenant, async (tx) => {
      // Checked again here: other uploads may have finished while this file was being stored.
      await checkQuota(c, tx, 'resumes');
      await checkFileBytes(c, tx, bytes.byteLength);
      const [resume] = await tx`
        insert into hire.resumes (company_id, candidate_id, storage_path, file_name, content_type, size_bytes, sha256)
        values (${principal.companyId}, ${id}, ${storagePath}, ${cleanFileName(file.name, kind.ext)},
                ${kind.contentType}, ${bytes.byteLength}, ${sha256Hex(bytes)})
        returning *`;
      await audit(
        c,
        tx,
        'resume.uploaded',
        { type: 'resume', id: resume!.id },
        { candidate_id: id, size_bytes: bytes.byteLength },
      );
      return resume!;
    });
    return row;
  } catch (err) {
    // The candidate may have been erased mid-upload; don't leave the file behind.
    await storage.remove([storagePath]).catch(() => {});
    if ((err as { code?: string }).code === '23503') throw notFound('candidate');
    throw err;
  }
}

resumes.openapi(
  createRoute({
    method: 'get',
    path: '/candidates/{id}/resumes',
    tags,
    security,
    summary: "List a candidate's résumés",
    request: { params: IdParam },
    responses: {
      200: json(z.object({ object: z.literal('list'), data: z.array(Resume) }), 'Newest first'),
      ...problems(404, 422),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { sql } = c.get('deps');
    const rows = await withTenant(sql, tenantOf(c), async (tx) => {
      const [candidate] = await tx`select id from hire.candidates where id = ${id}`;
      if (!candidate) throw notFound('candidate');
      return tx`select * from hire.resumes where candidate_id = ${id} order by created_at desc limit 100`;
    });
    return c.json({ object: 'list' as const, data: rows.map(resumeOut) }, 200);
  },
);

resumes.openapi(
  createRoute({
    method: 'get',
    path: '/resumes/{id}/download',
    tags,
    security,
    summary: 'Get a download link',
    description: 'Returns a private link to the file that expires after five minutes.',
    request: { params: IdParam },
    responses: { 200: json(DownloadLink, 'A short-lived link'), ...problems(404, 422) },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { sql, storage } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      const [resume] = await tx`select id, storage_path from hire.resumes where id = ${id}`;
      if (!resume) throw notFound('résumé');
      await audit(c, tx, 'resume.downloaded', { type: 'resume', id });
      return resume;
    });
    const url = await storage.signedUrl(row.storage_path, LINK_SECONDS);
    return c.json({ url, expires_at: new Date(Date.now() + LINK_SECONDS * 1000).toISOString() }, 200);
  },
);

resumes.openapi(
  createRoute({
    method: 'delete',
    path: '/resumes/{id}',
    tags,
    security,
    summary: 'Delete a résumé',
    request: { params: IdParam },
    responses: { 204: { description: 'Deleted' }, ...problems(403, 404, 422) },
  }),
  async (c) => {
    requireScope(c, 'write');
    const { id } = c.req.valid('param');
    const { sql, storage } = c.get('deps');
    const path = await withTenant(sql, tenantOf(c), async (tx) => {
      const [resume] = await tx`delete from hire.resumes where id = ${id} returning storage_path, candidate_id`;
      if (!resume) throw notFound('résumé');
      await tx`insert into hire.pending_file_deletions (storage_path, company_id)
               values (${resume.storage_path}, ${c.get('principal').companyId})`;
      await audit(c, tx, 'resume.deleted', { type: 'resume', id }, { candidate_id: resume.candidate_id });
      return resume.storage_path as string;
    });
    await removeFiles({ sql, storage }, [path]);
    return c.body(null, 204);
  },
);
