import { z } from '@hono/zod-openapi';

// Shared request and response shapes. These same definitions validate input
// and generate the OpenAPI document, so the docs cannot drift from the code.

export const STAGES = ['applied', 'screen', 'interview', 'offer', 'hired', 'rejected'] as const;
export const Stage = z.enum(STAGES).openapi('Stage');
export type StageName = (typeof STAGES)[number];

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const timestamp = z.iso.datetime().openapi({ example: '2026-11-03T15:04:05.000Z' });
// GitHub links are checked for shape only: a profile is github.com/<user>, a
// repository is github.com/<user>/<repo> with an optional path after it.
const GITHUB_PROFILE = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/?$/;
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}(?:\/[^\s]*)?$/;
const webLink = z.url({ protocol: /^https?$/ }).max(500);
const uuid = (example?: string) => z.uuid().openapi({ example: example ?? '5b3f8a5e-2c1d-4f7a-9a6e-0d1c2b3a4f5e' });

export const IdParam = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' }, example: '5b3f8a5e-2c1d-4f7a-9a6e-0d1c2b3a4f5e' }),
});

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25).openapi({ example: 25 }),
  cursor: z.string().max(500).optional().openapi({ description: 'next_cursor from the previous page' }),
});

export const listOf = <T extends z.ZodTypeAny>(item: T, name: string) =>
  z
    .object({
      object: z.literal('list'),
      data: z.array(item),
      next_cursor: z
        .string()
        .nullable()
        .openapi({ description: 'Pass as ?cursor= to get the next page; null on the last page' }),
    })
    .openapi(name);

export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string().openapi({ example: 'validation_failed' }),
    detail: z.string(),
    request_id: z.string(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    from: z.string().optional().openapi({ description: 'Refused stage moves: the current stage' }),
    to: z.string().optional().openapi({ description: 'Refused stage moves: the stage asked for' }),
    allowed: z
      .array(z.string())
      .optional()
      .openapi({ description: 'Refused stage moves: the stages it can move to from here' }),
    existing_id: z.string().optional().openapi({ description: 'Duplicates: the id of the record that already exists' }),
    quota: z.string().optional().openapi({ description: 'Sandbox caps: which cap was reached' }),
    limit: z.number().int().optional().openapi({ description: 'Sandbox caps: the size of that cap' }),
    retry_after: z.number().int().optional().openapi({ description: 'Rate limits: seconds until you can try again' }),
  })
  .openapi('Problem', { description: 'Every error uses this shape (RFC 9457 problem details).' });

// Jobs -----------------------------------------------------------------------

export const EmploymentType = z.enum(['full_time', 'part_time', 'contract', 'internship', 'temporary']);
export const JobStatus = z.enum(['draft', 'open', 'closed']);

export const Job = z
  .object({
    id: uuid(),
    object: z.literal('job'),
    title: z.string(),
    department: z.string().nullable(),
    location: z.string().nullable(),
    employment_type: EmploymentType,
    remote: z.boolean(),
    description: z.string().nullable(),
    status: JobStatus,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .openapi('Job');

export const JobCreate = z
  .object({
    title: trimmed(200).openapi({ example: 'Senior Product Designer' }),
    department: optionalText(100).openapi({ example: 'Design' }),
    location: optionalText(200).openapi({ example: 'Houston, TX' }),
    employment_type: EmploymentType.optional().openapi({ description: 'Defaults to full_time' }),
    remote: z.boolean().optional().openapi({ description: 'Defaults to false' }),
    description: optionalText(20000),
    status: JobStatus.optional().openapi({ description: 'Defaults to open' }),
  })
  .strict()
  .openapi('JobCreate');

export const JobUpdate = JobCreate.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' })
  .openapi('JobUpdate');

// Candidates -------------------------------------------------------------------

export const Candidate = z
  .object({
    id: uuid(),
    object: z.literal('candidate'),
    first_name: z.string(),
    last_name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    linkedin_url: z.string().nullable(),
    github_url: z.string().nullable(),
    source: z.string().nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .openapi('Candidate');

export const CandidateCreate = z
  .object({
    first_name: trimmed(100).openapi({ example: 'Jordan' }),
    last_name: trimmed(100).openapi({ example: 'Avery' }),
    email: z.email().max(254).toLowerCase().openapi({ example: 'jordan.avery@example.com' }),
    phone: z
      .string()
      .trim()
      .regex(/^[+()\d\s.-]{7,40}$/, 'Use digits, spaces and + ( ) - . only')
      .nullable()
      .optional()
      .openapi({ example: '+1 713 555 0142' }),
    location: optionalText(200).openapi({ example: 'Austin, TX' }),
    linkedin_url: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .nullable()
      .optional()
      .openapi({ example: 'https://www.linkedin.com/in/jordan-avery' }),
    github_url: z
      .string()
      .trim()
      .max(500)
      .regex(GITHUB_PROFILE, 'Use a GitHub profile link, like https://github.com/username')
      .nullable()
      .optional()
      .openapi({ example: 'https://github.com/jordan-avery' }),
    source: optionalText(100).openapi({ example: 'referral' }),
  })
  .strict()
  .openapi('CandidateCreate');

export const CandidateUpdate = CandidateCreate.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' })
  .openapi('CandidateUpdate');

// Applications -------------------------------------------------------------------

export const Application = z
  .object({
    id: uuid(),
    object: z.literal('application'),
    job_id: uuid(),
    candidate_id: uuid(),
    stage: Stage,
    rejection_reason: z.string().nullable(),
    stage_changed_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    candidate: z.object({ id: uuid(), first_name: z.string(), last_name: z.string(), email: z.string() }),
    job: z.object({ id: uuid(), title: z.string() }),
  })
  .openapi('Application');

export const ApplicationCreate = z
  .object({
    job_id: uuid(),
    candidate_id: uuid().optional().openapi({ description: 'An existing candidate. Send this or `candidate`.' }),
    candidate: CandidateCreate.optional().openapi({
      description: 'A new candidate, matched to an existing one by email if they already applied elsewhere.',
    }),
    note: optionalText(1000),
  })
  .strict()
  .refine((v) => (v.candidate_id === undefined) !== (v.candidate === undefined), {
    message: 'Send exactly one of candidate_id or candidate',
    path: ['candidate_id'],
  })
  .openapi('ApplicationCreate');

export const StageChange = z
  .object({
    to: Stage.openapi({ example: 'interview' }),
    note: optionalText(1000).openapi({ example: 'Strong portfolio, booked a panel for Thursday.' }),
    rejection_reason: optionalText(500),
  })
  .strict()
  .refine((v) => v.rejection_reason == null || v.to === 'rejected', {
    message: 'rejection_reason is only allowed when moving to rejected',
    path: ['rejection_reason'],
  })
  .openapi('StageChange');

export const StageHistoryEntry = z
  .object({
    id: z.number().int(),
    from_stage: Stage.nullable(),
    to_stage: Stage,
    changed_by: z.string().openapi({ example: 'api_key:5b3f8a5e-2c1d-4f7a-9a6e-0d1c2b3a4f5e' }),
    note: z.string().nullable(),
    changed_at: timestamp,
  })
  .openapi('StageHistoryEntry');

export const Pipeline = z
  .object({
    object: z.literal('pipeline'),
    job_id: uuid().nullable(),
    total: z.number().int(),
    stages: z.record(Stage, z.number().int()),
  })
  .openapi('Pipeline');

// Résumés -------------------------------------------------------------------------

export const Resume = z
  .object({
    id: uuid(),
    object: z.literal('resume'),
    candidate_id: uuid(),
    file_name: z.string(),
    content_type: z.string(),
    size_bytes: z.number().int(),
    sha256: z.string(),
    created_at: timestamp,
  })
  .openapi('Resume');

export const ResumeUpload = z
  .object({
    file: z.any().openapi({ type: 'string', format: 'binary', description: 'PDF or Word document, up to 4 MB' }),
  })
  .openapi('ResumeUpload');

// Projects -------------------------------------------------------------------------

export const Project = z
  .object({
    id: uuid(),
    object: z.literal('project'),
    candidate_id: uuid(),
    title: z.string(),
    description: z.string().nullable(),
    repo_url: z.string().nullable().openapi({ description: 'The GitHub repository with the code' }),
    live_url: z.string().nullable().openapi({ description: 'Where the finished project can be seen' }),
    file: z
      .object({ file_name: z.string(), content_type: z.string(), size_bytes: z.number().int(), sha256: z.string() })
      .nullable()
      .openapi({ description: 'The uploaded file, if any. Open it with GET /v1/projects/{id}/download.' }),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .openapi('Project');

export const ProjectCreate = z
  .object({
    title: trimmed(200).openapi({ example: 'Shift scheduler' }),
    description: optionalText(2000).openapi({
      example: 'A scheduling app for a 40-person clinic. React front end, Postgres, deployed on Vercel.',
    }),
    repo_url: z
      .string()
      .trim()
      .max(500)
      .regex(GITHUB_REPO, 'Use a GitHub repository link, like https://github.com/username/project')
      .nullable()
      .optional()
      .openapi({ example: 'https://github.com/jordan-avery/shift-scheduler' }),
    live_url: webLink.nullable().optional().openapi({ example: 'https://shift-scheduler.example.com' }),
  })
  .strict()
  .openapi('ProjectCreate');

export const ProjectUpdate = ProjectCreate.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' })
  .openapi('ProjectUpdate');

export const ProjectUpload = z
  .object({
    file: z.any().openapi({
      type: 'string',
      format: 'binary',
      description: 'ZIP of the code, PDF, PNG or JPEG, up to 4 MB',
    }),
  })
  .openapi('ProjectUpload');

// Public apply page ---------------------------------------------------------------

export const PublicJob = z
  .object({
    id: uuid(),
    object: z.literal('public_job'),
    title: z.string(),
    department: z.string().nullable(),
    location: z.string().nullable(),
    employment_type: EmploymentType,
    remote: z.boolean(),
    description: z.string().nullable(),
    company: z.object({ name: z.string(), sandbox: z.boolean() }),
    accepting_applications: z.boolean(),
  })
  .openapi('PublicJob');

export const PublicApplication = z
  .object({
    candidate: CandidateCreate.omit({ source: true }),
    project: ProjectCreate.optional().openapi({ description: 'Something they built, to show their work' }),
    message: optionalText(1000).openapi({ description: 'A note to the hiring team; saved with the application' }),
    consent: z.literal(true, { error: 'Agree to share your application with the employer' }),
  })
  .strict()
  .openapi('PublicApplication');

export const PublicApplicationReceipt = z
  .object({
    object: z.literal('public_application'),
    application_id: uuid(),
    project_id: uuid().nullable(),
    job_title: z.string(),
    company_name: z.string(),
    upload_token: z.string().openapi({
      description:
        'Lets this applicant send one résumé and one project file for this application, for 30 minutes. ' +
        'Send it as `Authorization: Bearer <upload_token>` to the two upload endpoints.',
    }),
    upload_token_expires_at: timestamp,
  })
  .openapi('PublicApplicationReceipt');

export const DownloadLink = z
  .object({ url: z.url(), expires_at: timestamp })
  .openapi('DownloadLink', { description: 'A private link that stops working after five minutes.' });

// Webhooks -------------------------------------------------------------------------

export const WebhookEvent = z.enum(['application.created', 'application.stage_changed']);

export const WebhookEndpoint = z
  .object({
    id: uuid(),
    object: z.literal('webhook_endpoint'),
    url: z.string(),
    description: z.string().nullable(),
    events: z.array(WebhookEvent),
    enabled: z.boolean(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .openapi('WebhookEndpoint');

export const WebhookEndpointWithSecret = WebhookEndpoint.extend({
  secret: z.string().openapi({ description: 'Shown once. Use it to check the Meridian-Signature header.' }),
}).openapi('WebhookEndpointWithSecret');

export const WebhookCreate = z
  .object({
    url: z.string().max(2000).openapi({ example: 'https://example.com/hooks/meridian' }),
    description: optionalText(200),
    events: z.array(WebhookEvent).min(1).optional().openapi({ description: 'Defaults to every event' }),
    enabled: z.boolean().optional().openapi({ description: 'Defaults to true' }),
  })
  .strict()
  .openapi('WebhookCreate');

export const WebhookUpdate = WebhookCreate.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' })
  .openapi('WebhookUpdate');

export const WebhookDelivery = z
  .object({
    id: uuid(),
    object: z.literal('webhook_delivery'),
    event_id: uuid(),
    event_type: z.string(),
    status: z.enum(['pending', 'succeeded', 'failed']),
    attempts: z.number().int(),
    last_status_code: z.number().int().nullable(),
    last_error: z.string().nullable(),
    next_attempt_at: timestamp,
    last_attempt_at: timestamp.nullable(),
    delivered_at: timestamp.nullable(),
    created_at: timestamp,
    payload: z.record(z.string(), z.unknown()),
  })
  .openapi('WebhookDelivery');

// API keys, audit log, account --------------------------------------------------------

export const Scope = z.enum(['read', 'write', 'admin']);

export const ApiKey = z
  .object({
    id: uuid(),
    object: z.literal('api_key'),
    name: z.string(),
    prefix: z.string().openapi({ example: 'mh_live_Xk3v9QpL' }),
    scopes: z.array(Scope),
    created_by: z.string(),
    created_at: timestamp,
    last_used_at: timestamp.nullable(),
    revoked_at: timestamp.nullable(),
  })
  .openapi('ApiKey');

export const ApiKeyWithSecret = ApiKey.extend({
  key: z.string().openapi({ description: 'Shown once. Store it somewhere safe.' }),
}).openapi('ApiKeyWithSecret');

export const ApiKeyCreate = z
  .object({
    name: trimmed(100).openapi({ example: 'Careers site' }),
    scopes: z.array(Scope).min(1).optional().openapi({ description: 'Defaults to read and write' }),
  })
  .strict()
  .openapi('ApiKeyCreate');

export const AuditEntry = z
  .object({
    id: z.number().int(),
    object: z.literal('audit_entry'),
    actor: z.string(),
    action: z.string().openapi({ example: 'application.stage_changed' }),
    entity_type: z.string().nullable(),
    entity_id: z.string().nullable(),
    request_id: z.string().nullable(),
    ip: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: timestamp,
  })
  .openapi('AuditEntry');

export const Company = z
  .object({
    id: uuid(),
    object: z.literal('company'),
    name: z.string(),
    plan: z.enum(['sandbox', 'starter', 'team', 'agency']),
    expires_at: timestamp.nullable(),
    created_at: timestamp,
  })
  .openapi('Company');

export const Me = z
  .object({
    company: Company,
    principal: z.object({ type: z.enum(['api_key', 'user', 'public']), id: uuid(), scopes: z.array(Scope) }),
    rate_limit: z.object({ requests_per_minute: z.number().int() }),
  })
  .openapi('Me');

export const Sandbox = z
  .object({
    object: z.literal('sandbox'),
    company: Company,
    api_key: z
      .string()
      .openapi({ description: 'A key for this sandbox only. It stops working when the sandbox expires.' }),
    expires_at: timestamp,
  })
  .openapi('Sandbox');
