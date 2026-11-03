import { createRoute } from '@hono/zod-openapi';
import { hitRateLimit, setRateLimitHeaders } from '../auth.js';
import { bodyLimit } from 'hono/body-limit';
import { clientIp, clientNetwork } from '../context.js';
import {
  encryptSecret,
  generateApiKey,
  generateWebhookSecret,
  verifyWebhookSignature,
  decryptSecret,
} from '../crypto.js';
import { ApiError } from '../errors.js';
import { json, problems, router } from '../openapi.js';
import { Sandbox } from '../schemas.js';
import { seedCompany } from '../seed.js';
import { companyOut } from '../serializers.js';

export const sandbox = router();

const PER_IP_PER_HOUR = 5;
const MAX_ACTIVE = 1000;
// A ceiling across everyone, so rotating addresses can't crowd out real visitors.
const GLOBAL_PER_HOUR = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIFETIME_HOURS = 24;

sandbox.openapi(
  createRoute({
    method: 'post',
    path: '/sandbox',
    tags: ['Sandbox'],
    summary: 'Create a sandbox',
    description:
      'No key needed. Creates a private demo company filled with sample jobs, candidates and applications, ' +
      'and returns an admin API key for it. Copy `api_key` into the Authorize box above to try every endpoint. ' +
      `Sandboxes are deleted after ${LIFETIME_HOURS} hours.`,
    responses: { 201: json(Sandbox, 'Your sandbox and its key'), ...problems(503) },
  }),
  async (c) => {
    const deps = c.get('deps');
    const { sql, storage, config } = deps;
    const limit = await hitRateLimit(sql, `sandbox:ip:${clientNetwork(c)}`, 3600, PER_IP_PER_HOUR);
    setRateLimitHeaders(c, PER_IP_PER_HOUR, limit);
    if (limit.exceeded) {
      throw new ApiError(
        'rate_limited',
        `You can create ${PER_IP_PER_HOUR} sandboxes an hour. Reuse the one you have.`,
      );
    }
    const [{ n }] = (await sql`
      select count(*) as n from hire.companies where plan = 'sandbox' and expires_at > now()`) as unknown as [
      { n: number },
    ];
    if (n >= MAX_ACTIVE) throw new ApiError('service_unavailable', 'The demo is very busy. Please try again later.');
    const global = await hitRateLimit(sql, 'sandbox:global', 3600, GLOBAL_PER_HOUR);
    if (global.exceeded)
      throw new ApiError('service_unavailable', 'The demo is very busy. Please try again in a few minutes.');

    const key = generateApiKey('sandbox');
    const company = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into hire.companies (name, plan, expires_at)
        values ('Bluebonnet Staffing (sandbox)', 'sandbox', now() + make_interval(hours => ${LIFETIME_HOURS}))
        returning *`;
      await tx`
        insert into hire.api_keys (company_id, name, prefix, key_hash, scopes, created_by)
        values (${row!.id}, 'Sandbox key', ${key.prefix}, ${key.hash}, ${['read', 'write', 'admin']}, 'system:sandbox')`;
      await tx`
        insert into hire.audit_log (company_id, actor, action, entity_type, entity_id, request_id, ip)
        values (${row!.id}, 'system:sandbox', 'sandbox.created', 'company', ${row!.id}, ${c.get('requestId')}, ${clientIp(c)})`;
      return row!;
    });
    await seedCompany(sql, storage, company.id);
    // Added after seeding, so the sample history doesn't fire events.
    await sql`
      insert into hire.webhook_endpoints (company_id, url, description, secret_ciphertext)
      values (${company.id}, ${`${config.publicBaseUrl}/demo/webhook-inbox`}, 'Demo receiver (checks signatures)',
              ${encryptSecret(generateWebhookSecret(), config.encryptionKey)})`;

    return c.json(
      {
        object: 'sandbox' as const,
        company: companyOut(company),
        api_key: key.key,
        expires_at: company.expires_at as Date,
      },
      201,
    );
  },
);

/**
 * A stand-in for a customer's server, used by sandboxes so webhooks have
 * somewhere to go. It checks the signature exactly as a real receiver would.
 */
export const demoInbox = router();

demoInbox.post(
  '/demo/webhook-inbox',
  bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ received: false, error: 'body too large' }, 413) }),
  async (c) => {
    const { sql, config } = c.get('deps');
    const deliveryId = c.req.header('meridian-delivery') ?? '';
    const signature = c.req.header('meridian-signature') ?? '';
    if (!UUID.test(deliveryId)) return c.json({ received: false, error: 'missing delivery id' }, 400);
    const limit = await hitRateLimit(sql, `inbox:ip:${clientNetwork(c)}`, 60, 300);
    if (limit.exceeded) return c.json({ received: false, error: 'rate limited' }, 429);
    const raw = await c.req.text();
    const [row] = await sql<{ secret_ciphertext: string }[]>`
    select e.secret_ciphertext from hire.webhook_deliveries d
    join hire.webhook_endpoints e on e.id = d.endpoint_id
    where d.id = ${deliveryId} and e.url like '%/demo/webhook-inbox'`;
    if (!row) return c.json({ received: false, error: 'unknown delivery' }, 404);
    const ok = verifyWebhookSignature(decryptSecret(row.secret_ciphertext, config.encryptionKey), raw, signature);
    return ok
      ? c.json({ received: true, signature: 'valid' }, 200)
      : c.json({ received: false, signature: 'invalid' }, 400);
  },
);
