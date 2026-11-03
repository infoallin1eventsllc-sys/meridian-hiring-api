// Database rows -> API objects. Listing fields explicitly means a new column
// never leaks into responses by accident (api_keys.key_hash, for example).

type Row = Record<string, any>;

export const jobOut = (r: Row) => ({
  id: r.id as string,
  object: 'job' as const,
  title: r.title as string,
  department: r.department as string | null,
  location: r.location as string | null,
  employment_type: r.employment_type,
  remote: r.remote as boolean,
  description: r.description as string | null,
  status: r.status,
  created_at: r.created_at as Date,
  updated_at: r.updated_at as Date,
});

export const candidateOut = (r: Row) => ({
  id: r.id as string,
  object: 'candidate' as const,
  first_name: r.first_name as string,
  last_name: r.last_name as string,
  email: r.email as string,
  phone: r.phone as string | null,
  location: r.location as string | null,
  linkedin_url: r.linkedin_url as string | null,
  source: r.source as string | null,
  created_at: r.created_at as Date,
  updated_at: r.updated_at as Date,
});

/** Expects the row from APPLICATION_SELECT. */
export const applicationOut = (r: Row) => ({
  id: r.id as string,
  object: 'application' as const,
  job_id: r.job_id as string,
  candidate_id: r.candidate_id as string,
  stage: r.stage,
  rejection_reason: r.rejection_reason as string | null,
  stage_changed_at: r.stage_changed_at as Date,
  created_at: r.created_at as Date,
  updated_at: r.updated_at as Date,
  candidate: {
    id: r.candidate_id as string,
    first_name: r.candidate_first_name as string,
    last_name: r.candidate_last_name as string,
    email: r.candidate_email as string,
  },
  job: { id: r.job_id as string, title: r.job_title as string },
});

export const historyOut = (r: Row) => ({
  id: r.id as number,
  from_stage: r.from_stage,
  to_stage: r.to_stage,
  changed_by: r.changed_by as string,
  note: r.note as string | null,
  changed_at: r.changed_at as Date,
});

export const resumeOut = (r: Row) => ({
  id: r.id as string,
  object: 'resume' as const,
  candidate_id: r.candidate_id as string,
  file_name: r.file_name as string,
  content_type: r.content_type as string,
  size_bytes: r.size_bytes as number,
  sha256: r.sha256 as string,
  created_at: r.created_at as Date,
});

export const webhookOut = (r: Row) => ({
  id: r.id as string,
  object: 'webhook_endpoint' as const,
  url: r.url as string,
  description: r.description as string | null,
  events: r.events,
  enabled: r.enabled as boolean,
  created_at: r.created_at as Date,
  updated_at: r.updated_at as Date,
});

export const deliveryOut = (r: Row) => ({
  id: r.id as string,
  object: 'webhook_delivery' as const,
  event_id: r.event_id as string,
  event_type: r.event_type as string,
  status: r.status,
  attempts: r.attempts as number,
  last_status_code: r.last_status_code as number | null,
  last_error: r.last_error as string | null,
  next_attempt_at: r.next_attempt_at as Date,
  last_attempt_at: r.last_attempt_at as Date | null,
  delivered_at: r.delivered_at as Date | null,
  created_at: r.created_at as Date,
  payload: r.payload as Record<string, unknown>,
});

export const apiKeyOut = (r: Row) => ({
  id: r.id as string,
  object: 'api_key' as const,
  name: r.name as string,
  prefix: r.prefix as string,
  scopes: r.scopes,
  created_by: r.created_by as string,
  created_at: r.created_at as Date,
  last_used_at: r.last_used_at as Date | null,
  revoked_at: r.revoked_at as Date | null,
});

export const auditOut = (r: Row) => ({
  id: r.id as number,
  object: 'audit_entry' as const,
  actor: r.actor as string,
  action: r.action as string,
  entity_type: r.entity_type as string | null,
  entity_id: r.entity_id as string | null,
  request_id: r.request_id as string | null,
  ip: r.ip as string | null,
  metadata: r.metadata as Record<string, unknown>,
  created_at: r.created_at as Date,
});

export const companyOut = (r: Row) => ({
  id: r.id as string,
  object: 'company' as const,
  name: r.name as string,
  plan: r.plan,
  expires_at: r.expires_at as Date | null,
  created_at: r.created_at as Date,
});
