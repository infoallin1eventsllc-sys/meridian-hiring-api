import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { looksLikeApiKey, hashApiKey } from './crypto.js';
import { ApiError } from './errors.js';
import { PLAN_LIMITS, type AppEnv, type Ctx, type Plan, type Principal, type Scope } from './context.js';
import type { Config } from './config.js';
import { SANDBOX_QUOTAS } from './quotas.js';
import type { Sql } from './db.js';

const ROLE_SCOPES: Record<string, Scope[]> = {
  owner: ['read', 'write', 'admin'],
  admin: ['read', 'write', 'admin'],
  recruiter: ['read', 'write'],
  viewer: ['read'],
};

async function principalFromApiKey(sql: Sql, key: string): Promise<Principal> {
  const [row] = await sql<
    { id: string; company_id: string; scopes: Scope[]; plan: Plan; revoked_at: Date | null; expires_at: Date | null }[]
  >`
    select k.id, k.company_id, k.scopes, k.revoked_at, c.plan, c.expires_at
    from hire.api_keys k join hire.companies c on c.id = k.company_id
    where k.key_hash = ${hashApiKey(key)}`;
  if (!row || row.revoked_at) throw new ApiError('unauthorized', 'This API key is not valid or has been revoked.');
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    throw new ApiError('unauthorized', 'This sandbox has expired. Create a new one with POST /v1/sandbox.');
  }
  // Recording "last used" at most once a minute keeps writes cheap.
  await sql`
    update hire.api_keys set last_used_at = now()
    where id = ${row.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
  return { type: 'api_key', id: row.id, companyId: row.company_id, plan: row.plan, scopes: row.scopes };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function verifySupabaseJwt(config: Config, token: string): Promise<JWTPayload> {
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new ApiError('unauthorized', 'The bearer token is neither an API key nor a valid login token.');
  }
  try {
    if (alg === 'HS256') {
      if (!config.supabaseJwtSecret) throw new Error('no secret');
      const { payload } = await jwtVerify(token, new TextEncoder().encode(config.supabaseJwtSecret), {
        audience: 'authenticated',
        algorithms: ['HS256'],
      });
      return payload;
    }
    if (!config.supabaseUrl) throw new Error('no issuer');
    jwks ??= createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks, {
      audience: 'authenticated',
      issuer: `${config.supabaseUrl}/auth/v1`,
      algorithms: ['ES256', 'RS256'],
    });
    return payload;
  } catch {
    throw new ApiError('unauthorized', 'Your login has expired or is not valid. Sign in again.');
  }
}

async function principalFromLogin(c: Ctx, token: string): Promise<Principal> {
  const { sql, config } = c.get('deps');
  const payload = await verifySupabaseJwt(config, token);
  const userId = payload.sub;
  if (!userId) throw new ApiError('unauthorized', 'Login token has no subject.');
  const memberships = await sql<{ company_id: string; role: string; plan: Plan }[]>`
    select m.company_id, m.role, c.plan
    from hire.company_members m join hire.companies c on c.id = m.company_id
    where m.user_id = ${userId}
    order by m.created_at`;
  if (memberships.length === 0) throw new ApiError('forbidden', 'This login is not a member of any company.');
  const wanted = c.req.header('meridian-company');
  const chosen = wanted ? memberships.find((m) => m.company_id === wanted) : memberships[0];
  if (!chosen) throw new ApiError('forbidden', 'You are not a member of the company in the Meridian-Company header.');
  if (!wanted && memberships.length > 1) {
    throw new ApiError('validation_failed', 'You belong to several companies. Send a Meridian-Company header.', {
      errors: [{ path: 'header.meridian-company', message: 'Required when a login belongs to several companies' }],
    });
  }
  return {
    type: 'user',
    id: userId,
    companyId: chosen.company_id,
    plan: chosen.plan,
    scopes: ROLE_SCOPES[chosen.role] ?? ['read'],
  };
}

export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) {
    throw new ApiError('unauthorized', 'Send an API key: Authorization: Bearer mh_live_…');
  }
  const token = match[1];
  const { sql } = c.get('deps');
  const principal = looksLikeApiKey(token) ? await principalFromApiKey(sql, token) : await principalFromLogin(c, token);
  c.set('principal', principal);

  // One budget per company, so minting more keys doesn't buy more requests.
  const limit = PLAN_LIMITS[principal.plan].requestsPerMinute;
  const result = await hitRateLimit(sql, `company:${principal.companyId}`, 60, limit);
  setRateLimitHeaders(c, limit, result);
  if (result.exceeded) {
    throw new ApiError('rate_limited', `Rate limit of ${limit} requests per minute exceeded. Try again shortly.`, {
      retry_after: result.resetSeconds,
    });
  }
  if (principal.plan === 'sandbox' && c.req.method !== 'GET') {
    const writes = await hitRateLimit(sql, `company:${principal.companyId}:writes`, 86400, SANDBOX_QUOTAS.writesPerDay);
    if (writes.exceeded) {
      throw new ApiError(
        'rate_limited',
        `Sandboxes allow ${SANDBOX_QUOTAS.writesPerDay} changes a day. Start a new sandbox to keep exploring.`,
        {
          retry_after: writes.resetSeconds,
        },
      );
    }
  }
  await next();
});

export function requireScope(c: Ctx, scope: Scope) {
  if (!c.get('principal').scopes.includes(scope)) {
    throw new ApiError('forbidden', `This key needs the "${scope}" scope for that action.`);
  }
}

export interface RateLimitResult {
  hits: number;
  remaining: number;
  resetSeconds: number;
  exceeded: boolean;
}

export async function hitRateLimit(
  sql: Sql,
  bucket: string,
  windowSeconds: number,
  limit: number,
): Promise<RateLimitResult> {
  const [row] = await sql<{ hits: number; window_start: Date }[]>`
    select * from hire.hit_rate_limit(${bucket}, ${windowSeconds})`;
  const hits = row!.hits;
  const resetAt = row!.window_start.getTime() + windowSeconds * 1000;
  return {
    hits,
    remaining: Math.max(0, limit - hits),
    resetSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    exceeded: hits > limit,
  };
}

export function setRateLimitHeaders(c: Ctx, limit: number, r: RateLimitResult) {
  c.header('RateLimit-Limit', String(limit));
  c.header('RateLimit-Remaining', String(r.remaining));
  c.header('RateLimit-Reset', String(r.resetSeconds));
  if (r.exceeded) c.header('Retry-After', String(r.resetSeconds));
}
