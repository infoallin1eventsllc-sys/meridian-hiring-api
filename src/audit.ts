import { clientIp, type Ctx } from './context.js';
import type { Tx } from './db.js';

/**
 * Writes one audit entry inside the request's transaction, so the entry
 * exists if and only if the change it describes was committed.
 * Never put candidate personal data in `metadata`.
 */
export async function audit(
  c: Ctx,
  tx: Tx,
  action: string,
  entity: { type: string; id: string },
  metadata: Record<string, unknown> = {},
) {
  const p = c.get('principal');
  await tx`
    insert into hire.audit_log (company_id, actor, action, entity_type, entity_id, request_id, ip, user_agent, metadata)
    values (${p.companyId}, ${`${p.type}:${p.id}`}, ${action}, ${entity.type}, ${entity.id},
            ${c.get('requestId')}, ${clientIp(c)}, ${c.req.header('user-agent')?.slice(0, 300) ?? null},
            ${tx.json(metadata as never)})`;
}
