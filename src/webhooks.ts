import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { decryptSecret, signWebhook } from './crypto.js';
import type { Deps } from './context.js';

// Retry schedule after a failed attempt. After the last one the delivery is
// marked failed and stays in the delivery log.
export const RETRY_DELAYS_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 12 * 3600];
const TIMEOUT_MS = 8000;

export const WEBHOOK_EVENTS = ['application.created', 'application.stage_changed', 'ping'] as const;

// Addresses a webhook must never reach: loopback, private networks, link-local
// (including cloud metadata at 169.254.169.254), carrier NAT, documentation
// ranges, multicast, and IPv6 tunnels that can wrap a private IPv4 address.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 127],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['2001::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return blocked.check(address, 'ipv4');
}

/** Checks the shape of a webhook URL when it is saved. The address is checked again on every send. */
export function webhookUrlProblem(raw: string, allowPrivate: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Must be a valid URL';
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return 'Must use https://';
  if (url.username || url.password) return 'Must not contain a username or password';
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
      return 'Must be a public address';
    if (isIP(host) && isBlockedAddress(host)) return 'Must be a public address';
    if (url.port && url.port !== '443') return 'Must use the standard https port (443)';
  }
  return undefined;
}

interface SendResult {
  statusCode?: number;
  error?: string;
}

/**
 * POSTs with node's http client so we can vet the resolved IP address right
 * before connecting (this also defeats DNS rebinding). Redirects are not followed.
 */
export function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  allowPrivate: boolean,
): Promise<SendResult> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const safeLookup = (
      hostname: string,
      options: object,
      callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
    ) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, []);
        const list = addresses as LookupAddress[];
        if (!allowPrivate && list.some((a) => isBlockedAddress(a.address))) {
          return callback(
            Object.assign(new Error('Destination resolves to a private address'), { code: 'EBLOCKED' }),
            [],
          );
        }
        if ((options as { all?: boolean }).all) return callback(null, list);
        const first = list[0];
        if (!first) return callback(Object.assign(new Error('No address found'), { code: 'ENOTFOUND' }), []);
        callback(null, first.address, first.family);
      });
    };
    const req = client.request(
      target,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
        lookup: safeLookup as never,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        res.resume(); // we only need the status code
        res.on('end', () => resolve({ statusCode: res.statusCode }));
        res.on('error', () => resolve({ statusCode: res.statusCode }));
      },
    );
    // `timeout` above only fires when the socket goes quiet; this caps the whole request.
    const deadline = setTimeout(() => req.destroy(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)));
    req.on('error', (err) => resolve({ error: err.message.slice(0, 300) }));
    req.end(body);
  });
}

interface DueDelivery {
  id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret_ciphertext: string;
}

/**
 * Sends deliveries that are due. Rows are leased with SKIP LOCKED so two
 * workers (say, the cron and a request's background task) never send the
 * same delivery at once. Runs as the schema owner: it is a system job that
 * spans companies.
 */
export async function processDueDeliveries(
  deps: Deps,
  opts: { limit?: number; companyId?: string; deliveryId?: string } = {},
) {
  const { sql, config } = deps;
  const leased = await sql<DueDelivery[]>`
    with due as (
      select d.id from hire.webhook_deliveries d
      -- A paused endpoint keeps its queue but sends nothing until it is enabled again.
      join hire.webhook_endpoints e on e.id = d.endpoint_id and e.enabled
      where d.status = 'pending' and d.next_attempt_at <= now()
        ${opts.companyId ? sql`and d.company_id = ${opts.companyId}` : sql``}
        ${opts.deliveryId ? sql`and d.id = ${opts.deliveryId}` : sql``}
      order by d.next_attempt_at
      limit ${opts.limit ?? 25}
      for update of d skip locked
    )
    update hire.webhook_deliveries d
    set next_attempt_at = now() + interval '2 minutes'
    from due, hire.webhook_endpoints e
    where d.id = due.id and e.id = d.endpoint_id
    returning d.id, d.event_id, d.event_type, d.payload, d.attempts, e.url, e.secret_ciphertext`;

  const results = await Promise.all(
    leased.map(async (d) => {
      const body = JSON.stringify(d.payload);
      let result: SendResult;
      try {
        const secret = decryptSecret(d.secret_ciphertext, config.encryptionKey);
        result = await postJson(
          d.url,
          body,
          {
            'User-Agent': 'MeridianHire-Webhooks/1.0',
            'Meridian-Event': d.event_type,
            'Meridian-Event-Id': d.event_id,
            'Meridian-Delivery': d.id,
            'Meridian-Signature': signWebhook(secret, body),
          },
          config.allowPrivateWebhooks,
        );
      } catch (err) {
        result = { error: (err as Error).message };
      }
      const ok = result.statusCode !== undefined && result.statusCode >= 200 && result.statusCode < 300;
      const attempts = d.attempts + 1;
      const delay = RETRY_DELAYS_SECONDS[attempts - 1];
      const status = ok ? 'succeeded' : delay === undefined ? 'failed' : 'pending';
      const error = ok ? null : (result.error ?? `Receiver answered HTTP ${result.statusCode}`);
      await sql`
        update hire.webhook_deliveries set
          attempts = ${attempts},
          status = ${status},
          last_attempt_at = now(),
          last_status_code = ${result.statusCode ?? null},
          last_error = ${error},
          delivered_at = ${ok ? sql`now()` : null},
          next_attempt_at = ${status === 'pending' ? sql`now() + make_interval(secs => ${delay!})` : sql`next_attempt_at`}
        where id = ${d.id}`;
      return status;
    }),
  );
  return {
    attempted: results.length,
    succeeded: results.filter((s) => s === 'succeeded').length,
    retrying: results.filter((s) => s === 'pending').length,
    failed: results.filter((s) => s === 'failed').length,
  };
}
