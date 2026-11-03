import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** API keys look like `mh_live_<43 chars>`. Only a SHA-256 hash is stored. */
export function generateApiKey(kind: 'live' | 'sandbox' = 'live') {
  const secret = randomBytes(32).toString('base64url');
  const key = `mh_${kind}_${secret}`;
  return { key, prefix: key.slice(0, 16), hash: hashApiKey(key) };
}

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

export function looksLikeApiKey(token: string): boolean {
  return /^mh_(live|sandbox)_[A-Za-z0-9_-]{43}$/.test(token);
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

// Webhook signing secrets must be readable (we sign with them), so they are
// encrypted at rest with AES-256-GCM rather than hashed.
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(
    '.',
  );
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/** `Meridian-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">` */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now - t) > toleranceSeconds || !parts.v1) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const given = Buffer.from(String(parts.v1));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
