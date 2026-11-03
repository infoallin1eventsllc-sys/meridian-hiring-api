import { ApiError } from './errors.js';
import type { Ctx } from './context.js';
import type { Tx } from './db.js';

// Sandboxes are open to anyone, so they get hard caps on what they can store.
// Paid plans will get their own limits in Phase 2 (see docs/PLAN.md).
export const SANDBOX_QUOTAS = {
  jobs: 50,
  candidates: 200,
  applications: 500,
  resumes: 25,
  resumeBytes: 20 * 1024 * 1024,
  webhook_endpoints: 3,
  api_keys: 5,
  /** Writes (anything but GET) per sandbox per day. Bounds audit and webhook rows too. */
  writesPerDay: 2000,
};

type Counted = 'jobs' | 'candidates' | 'applications' | 'resumes' | 'webhook_endpoints' | 'api_keys';

/** Throws 409 when a sandbox would go over its cap for `table`. Runs inside the request's tenant transaction. */
export async function checkQuota(c: Ctx, tx: Tx, table: Counted, adding = 1) {
  if (c.get('principal').plan !== 'sandbox') return;
  const filter = table === 'api_keys' ? tx`where revoked_at is null` : tx``;
  const [{ n }] = (await tx`select count(*) as n from ${tx('hire.' + table)} ${filter}`) as unknown as [{ n: number }];
  const cap = SANDBOX_QUOTAS[table];
  if (n + adding > cap) {
    throw new ApiError(
      'conflict',
      `Sandboxes can hold up to ${cap} ${table.replace('_', ' ')}. Start a new sandbox to keep exploring.`,
      {
        quota: table,
        limit: cap,
      },
    );
  }
}

export async function checkResumeBytes(c: Ctx, tx: Tx, adding: number) {
  if (c.get('principal').plan !== 'sandbox') return;
  const [{ total }] = (await tx`select coalesce(sum(size_bytes), 0)::bigint as total from hire.resumes`) as unknown as [
    { total: number },
  ];
  if (total + adding > SANDBOX_QUOTAS.resumeBytes) {
    throw new ApiError(
      'conflict',
      'This sandbox has used its 20 MB of résumé storage. Start a new sandbox to keep exploring.',
      {
        quota: 'resume_bytes',
        limit: SANDBOX_QUOTAS.resumeBytes,
      },
    );
  }
}
