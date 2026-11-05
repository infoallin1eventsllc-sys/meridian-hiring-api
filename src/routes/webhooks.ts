import { randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { audit } from '../audit.js';
import { requireScope } from '../auth.js';
import { tenantOf, type Ctx } from '../context.js';
import { encryptSecret, generateWebhookSecret } from '../crypto.js';
import { withTenant } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { body, json, problems, router, security } from '../openapi.js';
import { decodeCursor, page } from '../pagination.js';
import {
  IdParam,
  PageQuery,
  WebhookCreate,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  WebhookUpdate,
  listOf,
} from '../schemas.js';
import { deliveryOut, webhookOut } from '../serializers.js';
import { processDueDeliveries, webhookUrlProblem } from '../webhooks.js';
import { checkQuota } from '../quotas.js';

const tags = ['Webhooks'];
export const webhooks = router();

const MAX_ENDPOINTS = 10;
// Sandboxes are open to anyone, so they may only send to the demo receiver
// or a webhook.site inbox (https://webhook.site/<uuid>), nowhere else.
const WEBHOOK_SITE = /^https:\/\/webhook\.site\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

function checkUrl(c: Ctx, url: string) {
  const { config } = c.get('deps');
  const problem = webhookUrlProblem(url, config.allowPrivateWebhooks);
  if (problem)
    throw new ApiError('validation_failed', 'The webhook URL is not allowed.', {
      errors: [{ path: 'url', message: problem }],
    });
  if (c.get('principal').plan === 'sandbox' && !config.allowPrivateWebhooks) {
    const inbox = `${config.publicBaseUrl}/demo/webhook-inbox`;
    if (url !== inbox && !WEBHOOK_SITE.test(url)) {
      throw new ApiError('validation_failed', 'Sandboxes can only send webhooks to webhook.site or this demo.', {
        errors: [{ path: 'url', message: `Use https://webhook.site/<your-id> or ${inbox}` }],
      });
    }
  }
}

webhooks.openapi(
  createRoute({
    method: 'post',
    path: '/webhooks',
    tags,
    security,
    summary: 'Add a webhook endpoint',
    description:
      'We POST a signed JSON event to this URL whenever an application is created or changes stage. The ' +
      'response includes the signing `secret` once. Failed deliveries are retried after 1 min, 5 min, 30 min, ' +
      '2 h and 12 h. Needs the `admin` scope.',
    request: body(WebhookCreate),
    responses: { 201: json(WebhookEndpointWithSecret, 'The endpoint and its secret'), ...problems(403, 409, 422) },
  }),
  async (c) => {
    requireScope(c, 'admin');
    const input = c.req.valid('json');
    checkUrl(c, input.url);
    const { sql, config } = c.get('deps');
    const secret = generateWebhookSecret();
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      await checkQuota(c, tx, 'webhook_endpoints');
      const [{ n }] = (await tx`select count(*) as n from hire.webhook_endpoints`) as unknown as [{ n: number }];
      if (n >= MAX_ENDPOINTS)
        throw new ApiError('conflict', `A company can have up to ${MAX_ENDPOINTS} webhook endpoints.`);
      const [endpoint] = await tx`
        insert into hire.webhook_endpoints (company_id, url, description, events, enabled, secret_ciphertext)
        values (${c.get('principal').companyId}, ${input.url}, ${input.description ?? null},
                ${input.events ?? ['application.created', 'application.stage_changed']}, ${input.enabled ?? true},
                ${encryptSecret(secret, config.encryptionKey)})
        returning *`;
      await audit(c, tx, 'webhook.created', { type: 'webhook_endpoint', id: endpoint!.id }, { url: input.url });
      return endpoint!;
    });
    return c.json({ ...webhookOut(row), secret }, 201);
  },
);

webhooks.openapi(
  createRoute({
    method: 'get',
    path: '/webhooks',
    tags,
    security,
    summary: 'List webhook endpoints',
    responses: {
      200: json(z.object({ object: z.literal('list'), data: z.array(WebhookEndpoint) }), 'All endpoints'),
      ...problems(),
    },
  }),
  async (c) => {
    const { sql } = c.get('deps');
    const rows = await withTenant(
      sql,
      tenantOf(c),
      (tx) => tx`select * from hire.webhook_endpoints order by created_at desc, id desc`,
    );
    return c.json({ object: 'list' as const, data: rows.map(webhookOut) }, 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'patch',
    path: '/webhooks/{id}',
    tags,
    security,
    summary: 'Update a webhook endpoint',
    description: 'Change the URL or events, or set `enabled: false` to pause deliveries. Needs the `admin` scope.',
    request: { params: IdParam, ...body(WebhookUpdate) },
    responses: { 200: json(WebhookEndpoint, 'The updated endpoint'), ...problems(403, 404, 422) },
  }),
  async (c) => {
    requireScope(c, 'admin');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    if (input.url) checkUrl(c, input.url);
    const { sql } = c.get('deps');
    const row = await withTenant(sql, tenantOf(c), async (tx) => {
      const [endpoint] = await tx`
        update hire.webhook_endpoints set ${tx(input as Record<string, unknown>)} where id = ${id} returning *`;
      if (!endpoint) throw notFound('webhook endpoint');
      await audit(c, tx, 'webhook.updated', { type: 'webhook_endpoint', id }, { fields: Object.keys(input) });
      return endpoint;
    });
    return c.json(webhookOut(row), 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'delete',
    path: '/webhooks/{id}',
    tags,
    security,
    summary: 'Delete a webhook endpoint',
    request: { params: IdParam },
    responses: { 204: { description: 'Deleted' }, ...problems(403, 404, 422) },
  }),
  async (c) => {
    requireScope(c, 'admin');
    const { id } = c.req.valid('param');
    const { sql } = c.get('deps');
    await withTenant(sql, tenantOf(c), async (tx) => {
      const [endpoint] = await tx`delete from hire.webhook_endpoints where id = ${id} returning id`;
      if (!endpoint) throw notFound('webhook endpoint');
      await audit(c, tx, 'webhook.deleted', { type: 'webhook_endpoint', id });
    });
    return c.body(null, 204);
  },
);

webhooks.openapi(
  createRoute({
    method: 'post',
    path: '/webhooks/{id}/test',
    tags,
    security,
    summary: 'Send a test event',
    description: 'Sends a `ping` event right away so you can check your receiver and signature code.',
    request: { params: IdParam },
    responses: { 200: json(WebhookDelivery, 'The delivery and how it went'), ...problems(403, 404, 422) },
  }),
  async (c) => {
    requireScope(c, 'admin');
    const { id } = c.req.valid('param');
    const deps = c.get('deps');
    const companyId = c.get('principal').companyId;
    const [endpoint] = await withTenant(deps.sql, tenantOf(c), async (tx) => {
      const rows = await tx`select id from hire.webhook_endpoints where id = ${id}`;
      if (rows[0]) await audit(c, tx, 'webhook.tested', { type: 'webhook_endpoint', id });
      return rows;
    });
    if (!endpoint) throw notFound('webhook endpoint');
    // The API role can only read deliveries; system code writes them.
    const eventId = randomUUID();
    const [delivery] = await deps.sql`
      insert into hire.webhook_deliveries (company_id, endpoint_id, event_id, event_type, payload)
      values (${companyId}, ${id}, ${eventId}, 'ping', ${deps.sql.json({
        id: eventId,
        type: 'ping',
        created_at: new Date().toISOString(),
        company_id: companyId,
        data: { message: 'Hello from Meridian Hire' },
      })})
      returning id`;
    await processDueDeliveries(deps, { companyId, deliveryId: delivery!.id });
    const [row] = await deps.sql`select * from hire.webhook_deliveries where id = ${delivery!.id}`;
    return c.json(deliveryOut(row!), 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'get',
    path: '/webhooks/{id}/deliveries',
    tags,
    security,
    summary: 'Delivery log',
    description: 'Every event sent to this endpoint, newest first, with status, attempts and the last error.',
    request: {
      params: IdParam,
      query: PageQuery.extend({ status: z.enum(['pending', 'succeeded', 'failed']).optional() }),
    },
    responses: {
      200: json(listOf(WebhookDelivery, 'WebhookDeliveryList'), 'A page of deliveries'),
      ...problems(404, 422),
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { limit, cursor, status } = c.req.valid('query');
    const after = decodeCursor(cursor);
    const { sql } = c.get('deps');
    const rows = await withTenant(sql, tenantOf(c), async (tx) => {
      const [endpoint] = await tx`select id from hire.webhook_endpoints where id = ${id}`;
      if (!endpoint) throw notFound('webhook endpoint');
      return tx`
        select * from hire.webhook_deliveries
        where endpoint_id = ${id}
          ${status ? tx`and status = ${status}` : tx``}
          ${after ? tx`and (created_at, id) < (${after.createdAt}, ${after.id})` : tx``}
        order by created_at desc, id desc
        limit ${limit + 1}`;
    });
    const result = page(rows, limit);
    return c.json(
      { object: 'list' as const, data: result.data.map(deliveryOut), next_cursor: result.next_cursor },
      200,
    );
  },
);
