import type { Context } from 'hono';
import type { Config } from './config.js';
import type { Sql, TenantContext } from './db.js';
import type { Storage } from './storage.js';

export type Scope = 'read' | 'write' | 'admin';
export type Plan = 'sandbox' | 'starter' | 'team' | 'agency';

export interface Principal {
  /** 'public' is a candidate on the apply page: no key, limited to applying to one open job. */
  type: 'api_key' | 'user' | 'public';
  id: string;
  companyId: string;
  plan: Plan;
  scopes: Scope[];
}

export interface Deps {
  sql: Sql;
  config: Config;
  storage: Storage;
  /** Keeps work alive after the response is sent (Vercel's waitUntil in production). */
  background: (task: Promise<unknown>) => void;
}

export interface AppEnv {
  Variables: {
    deps: Deps;
    requestId: string;
    principal: Principal;
  };
}

export type Ctx = Context<AppEnv>;

export function tenantOf(c: Ctx): TenantContext {
  const p = c.get('principal');
  return { companyId: p.companyId, actor: `${p.type}:${p.id}` };
}

/** The caller's address. Vercel sets x-real-ip itself, so it can't be spoofed there. */
export function clientIp(c: Ctx): string {
  return c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

/** For rate limits: IPv6 users usually control a whole /64, so count the /64 as one address. */
export function clientNetwork(c: Ctx): string {
  const ip = clientIp(c);
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Requests per minute, per company (all its keys and logins share one budget). */
export const PLAN_LIMITS: Record<Plan, { requestsPerMinute: number }> = {
  sandbox: { requestsPerMinute: 60 },
  starter: { requestsPerMinute: 120 },
  team: { requestsPerMinute: 600 },
  agency: { requestsPerMinute: 1200 },
};
