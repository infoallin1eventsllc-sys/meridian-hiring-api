import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, signWebhook, verifyWebhookSignature } from '../src/crypto.js';
import { isBlockedAddress, webhookUrlProblem } from '../src/webhooks.js';
import { apply, createCompany, makeApp, postJob, testSql } from './helpers.js';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

// A stand-in for a customer's server. It answers with whatever status `reply` holds.
const received: Received[] = [];
let reply = 200;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    res.writeHead(reply).end('ok');
  });
});
let receiverUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function setup() {
  const t = makeApp();
  const a = await createCompany();
  const hook = await t.request('POST', '/v1/webhooks', {
    key: a.key,
    body: { url: receiverUrl, description: 'Test receiver' },
  });
  expect(hook.status).toBe(201);
  expect(hook.body.secret).toMatch(/^whsec_/);
  return { t, a, hook: hook.body };
}

describe('webhooks', () => {
  it('sends a signed event when an application changes stage', async () => {
    reply = 200;
    const { t, a, hook } = await setup();
    const app = await apply(t, a.key, await postJob(t, a.key));
    await t.request('POST', `/v1/applications/${app.id}/stage`, {
      key: a.key,
      body: { to: 'interview', note: 'Panel booked' },
    });
    await t.settle();

    const mine = received.filter((r) => JSON.parse(r.body).company_id === a.companyId);
    expect(mine.map((r) => r.headers['meridian-event'])).toEqual(['application.created', 'application.stage_changed']);
    const event = mine[1]!;
    const payload = JSON.parse(event.body);
    expect(payload).toMatchObject({
      type: 'application.stage_changed',
      data: { application_id: app.id, from_stage: 'applied', to_stage: 'interview', note: 'Panel booked' },
    });
    // No personal data in the payload; receivers fetch details with their key.
    expect(event.body).not.toContain(app.candidate.email);
    expect(verifyWebhookSignature(hook.secret, event.body, String(event.headers['meridian-signature']))).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', event.body, String(event.headers['meridian-signature']))).toBe(false);

    const log = await t.request('GET', `/v1/webhooks/${hook.id}/deliveries`, { key: a.key });
    expect(log.body.data.every((d: { status: string }) => d.status === 'succeeded')).toBe(true);
    expect(log.body.data[0]).toMatchObject({ attempts: 1, last_status_code: 200 });
  });

  it('retries failed deliveries on a schedule, then gives up', async () => {
    reply = 500;
    const { t, a, hook } = await setup();
    await apply(t, a.key, await postJob(t, a.key));
    await t.settle();
    const sql = testSql();
    const [first] = await sql`select * from hire.webhook_deliveries where endpoint_id = ${hook.id}`;
    expect(first).toMatchObject({ status: 'pending', attempts: 1, last_status_code: 500 });
    const wait = (first!.next_attempt_at.getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(50);
    expect(wait).toBeLessThan(70);

    // Fast-forward through the remaining retries.
    for (let i = 0; i < 5; i++) {
      await sql`update hire.webhook_deliveries set next_attempt_at = now() where endpoint_id = ${hook.id}`;
      await t.request('POST', '/internal/tick', { headers: { Authorization: 'Bearer test-cron-secret' } });
    }
    const [last] = await sql`select * from hire.webhook_deliveries where endpoint_id = ${hook.id}`;
    expect(last).toMatchObject({ status: 'failed', attempts: 6 });

    reply = 200;
    const recovered = await t.request('POST', `/v1/webhooks/${hook.id}/test`, { key: a.key });
    expect(recovered.body).toMatchObject({ event_type: 'ping', status: 'succeeded' });
  });

  it('does not send to paused endpoints', async () => {
    reply = 200;
    const { t, a, hook } = await setup();
    await t.request('PATCH', `/v1/webhooks/${hook.id}`, { key: a.key, body: { enabled: false } });
    await apply(t, a.key, await postJob(t, a.key));
    await t.settle();
    expect(await testSql()`select 1 from hire.webhook_deliveries where endpoint_id = ${hook.id}`).toHaveLength(0);
  });

  it('never reveals the secret again, and stores it encrypted', async () => {
    const { t, a, hook } = await setup();
    const list = await t.request('GET', '/v1/webhooks', { key: a.key });
    expect(JSON.stringify(list.body)).not.toContain(hook.secret);
    const [row] = await testSql()`select secret_ciphertext from hire.webhook_endpoints where id = ${hook.id}`;
    expect(row!.secret_ciphertext).not.toContain(hook.secret);
  });

  it('refuses private and internal addresses outside of tests', async () => {
    expect(webhookUrlProblem('http://example.com/hook', false)).toMatch(/https/);
    expect(webhookUrlProblem('https://169.254.169.254/latest/meta-data', false)).toMatch(/public/);
    expect(webhookUrlProblem('https://localhost/hook', false)).toMatch(/public/);
    expect(webhookUrlProblem('https://user:pass@example.com/hook', false)).toMatch(/password/);
    expect(webhookUrlProblem('https://example.com/hook', false)).toBeUndefined();
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress('93.184.215.14')).toBe(false);

    const t = makeApp({ allowPrivateWebhooks: false });
    const a = await createCompany();
    const res = await t.request('POST', '/v1/webhooks', { key: a.key, body: { url: 'https://10.0.0.5/hook' } });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('url');
  });

  it('limits sandboxes to known test receivers', async () => {
    const t = makeApp({ allowPrivateWebhooks: false });
    const s = await createCompany({ plan: 'sandbox', expiresAt: new Date(Date.now() + 3600_000) });
    expect(
      (await t.request('POST', '/v1/webhooks', { key: s.key, body: { url: 'https://example.com/hook' } })).status,
    ).toBe(422);
    expect(
      (
        await t.request('POST', '/v1/webhooks', {
          key: s.key,
          body: { url: 'https://webhook.site/8f14e45f-ceea-467a-9575-2f1c0e2d3b4a' },
        })
      ).status,
    ).toBe(201);
  });

  it('signs, verifies and encrypts correctly', () => {
    const body = '{"hello":"world"}';
    const header = signWebhook('whsec_test', body, 1_700_000_000);
    expect(verifyWebhookSignature('whsec_test', body, header, 300, 1_700_000_100)).toBe(true);
    expect(verifyWebhookSignature('whsec_test', body + ' ', header, 300, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature('whsec_test', body, header, 300, 1_700_001_000)).toBe(false); // too old
    const key = Buffer.alloc(32, 7);
    expect(decryptSecret(encryptSecret('whsec_abc', key), key)).toBe('whsec_abc');
    expect(() => decryptSecret(encryptSecret('whsec_abc', key), Buffer.alloc(32, 8))).toThrow();
  });
});
