import { createRoute, z } from '@hono/zod-openapi';
import { audit } from '../audit.js';
import { requireScope } from '../auth.js';
import { PLAN_LIMITS, tenantOf } from '../context.js';
import { generateApiKey } from '../crypto.js';
import { withTenant } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { body, json, problems, router, security } from '../openapi.js';
import { decodeCursor, page } from '../pagination.js';
import { ApiKey, ApiKeyCreate, ApiKeyWithSecret, AuditEntry, IdParam, Me, PageQuery, listOf } from '../schemas.js';
import { apiKeyOut, auditOut, companyOut } from '../serializers.js';
import { checkQuota } from '../quotas.js';

export const account = router();

account.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['Account'],
    security,
    summary: 'Who am I?',
    description: 'The company and permissions behind the credentials you sent. A handy first call.',
    responses: { 200: json(Me, 'Your company and access'), ...problems() },
  }),
  async (c) => {
    const p = c.get('principal');
    const { sql } = c.get('deps');
    const [company] = await withTenant(sql, tenantOf(c), (tx) => tx`select * from hire.companies`);
    return c.json(
      {
        company: companyOut(company!),
        principal: { type: p.type, id: p.id, scopes: p.scopes },
        rate_limit: { requests_per_minute: PLAN_LIMITS[p.plan].requestsPerMinute },
      },
      200,
    );
  },
);

const keyTags = ['API keys'];

account.openapi(
  createRoute({
    method: 'get',
    path: '/api-keys',
    tags: keyTags,
    security,
    summary: 'List API keys',
    description: 'Keys are never shown again after creation; this lists their names, prefixes and use.',
    responses: {
      200: json(z.object({ object: z.literal('list'), data: z.array(ApiKey) }), 'All keys'),
      ...problems(403),
    },
  }),
  async (c) => {
    requireScope(c, 'admin');
    const { sql } = c.get('deps');
    const rows = await withTenant(sql, tenantOf(c), (tx) => tx`select * from hire.api_keys order by created_at desc`);
    return c.json({ object: 'list' as const, data: rows.map(apiKeyOut) }, 200);
  },
);

account.openapi(
  createRoute({
    method: 'post',
    path: '/api-keys',
    tags: keyTags,
    security,
    summary: 'Create an API key',
    description: 'The full key is returned once. Give each integration its own key so you can revoke one alone.',
    request: body(ApiKeyCreate),
    responses: { 201: json(ApiKeyWithSecret, 'The key; store it now'), ...problems(403, 422) },
  }),
  async (c) => {
    requireScope(c, 'admin');
    const input = c.req.valid('json');
    const p = c.get('principal');
    const { sql } = c.get('deps');
    const generated = generateApiKey(p.plan === 'sandbox' ? 'sandbox' : 'live');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      const [{ n }] = (await tx`select count(*) as n from hire.api_keys where revoked_at is null`) as unknown as [
        { n: number },
      ];
      if (n >= 25) throw new ApiError('conflict', 'A company can have up to 25 active keys. Revoke one first.');
      await checkQuota(c, tx, 'api_keys');
      const [key] = await tx`
        insert into hire.api_keys (company_id, name, prefix, key_hash, scopes)
        values (${p.companyId}, ${input.name}, ${generated.prefix}, ${generated.hash}, ${input.scopes ?? ['read', 'write']})
        returning *`;
      await audit(
        c,
        tx,
        'api_key.created',
        { type: 'api_key', id: key!.id },
        { name: input.name, scopes: key!.scopes },
      );
      return key!;
    });
    return c.json({ ...apiKeyOut(row), key: generated.key }, 201);
  },
);

account.openapi(
  createRoute({
    method: 'delete',
    path: '/api-keys/{id}',
    tags: keyTags,
    security,
    summary: 'Revoke an API key',
    description: 'The key stops working immediately. Revoked keys stay listed for the record.',
    request: { params: IdParam },
    responses: { 200: json(ApiKey, 'The revoked key'), ...problems(403, 404, 409, 422) },
  }),
  async (c) => {
    requireScope(c, 'admin');
    const { id } = c.req.valid('param');
    const p = c.get('principal');
    if (p.type === 'api_key' && p.id === id) {
      throw new ApiError('conflict', "A key can't revoke itself. Use another admin key or sign in.");
    }
    const { sql } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      const [key] = await tx`
        update hire.api_keys set revoked_at = coalesce(revoked_at, now()) where id = ${id} returning *`;
      if (!key) throw notFound('API key');
      await audit(c, tx, 'api_key.revoked', { type: 'api_key', id });
      return key;
    });
    return c.json(apiKeyOut(row), 200);
  },
);

account.openapi(
  createRoute({
    method: 'get',
    path: '/audit-log',
    tags: ['Audit log'],
    security,
    summary: 'Audit log',
    description:
      'Who did what and when, newest first. Entries cannot be edited or deleted through the API. Needs the `admin` scope.',
    request: {
      query: PageQuery.extend({
        action: z.string().max(100).optional().openapi({ example: 'application.stage_changed' }),
        entity_type: z.string().max(50).optional().openapi({ example: 'application' }),
        entity_id: z.string().max(100).optional(),
      }),
    },
    responses: { 200: json(listOf(AuditEntry, 'AuditEntryList'), 'A page of entries'), ...problems(403, 422) },
  }),
  async (c) => {
    requireScope(c, 'admin');
    const { limit, cursor, action, entity_type, entity_id } = c.req.valid('query');
    const after = decodeCursor(cursor, 'int');
    const { sql } = c.get('deps');
    const rows = await withTenant(
      sql,
      tenantOf(c),
      (tx) => tx`
      select * from hire.audit_log
      where true
        ${action ? tx`and action = ${action}` : tx``}
        ${entity_type ? tx`and entity_type = ${entity_type}` : tx``}
        ${entity_id ? tx`and entity_id = ${entity_id}` : tx``}
        ${after ? tx`and id < ${Number(after.id)}` : tx``}
      order by id desc
      limit ${limit + 1}`,
    );
    const result = page(rows, limit);
    return c.json({ object: 'list' as const, data: result.data.map(auditOut), next_cursor: result.next_cursor }, 200);
  },
);
