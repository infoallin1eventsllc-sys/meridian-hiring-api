-- Meridian Hire: core schema.
--
-- Every tenant-owned table carries company_id and has row-level security.
-- The API connects as the schema owner, then runs each request inside a
-- transaction that does `SET LOCAL ROLE hire_app` and sets app.company_id.
-- hire_app is subject to the policies below, so a query that forgets a
-- WHERE clause still only sees the caller's own company.

create schema if not exists hire;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hire_app') then
    create role hire_app nologin;
  end if;
end
$$;

-- The connecting role must be able to switch into hire_app.
grant hire_app to current_user;
grant usage on schema hire to hire_app;

create or replace function hire.current_company_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.company_id', true), '')::uuid $$;

create or replace function hire.current_actor() returns text
language sql stable
as $$ select coalesce(nullif(current_setting('app.actor', true), ''), 'system') $$;

create or replace function hire.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create type hire.plan as enum ('sandbox', 'starter', 'team', 'agency');
create type hire.job_status as enum ('draft', 'open', 'closed');
create type hire.stage as enum ('applied', 'screen', 'interview', 'offer', 'hired', 'rejected');

-- Companies -----------------------------------------------------------------

create table hire.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  plan hire.plan not null default 'starter',
  -- Sandboxes are throwaway demo companies; they are deleted after this time.
  expires_at timestamptz(3),
  created_at timestamptz(3) not null default now()
);

create table hire.company_members (
  company_id uuid not null references hire.companies on delete cascade,
  user_id uuid not null, -- Supabase auth.users.id
  role text not null check (role in ('owner', 'admin', 'recruiter', 'viewer')),
  created_at timestamptz(3) not null default now(),
  primary key (company_id, user_id)
);
create index on hire.company_members (user_id);

create table hire.api_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references hire.companies on delete cascade,
  name text not null check (length(name) between 1 and 100),
  prefix text not null,
  key_hash bytea not null unique,
  scopes text[] not null default '{read,write}'
    check (scopes <@ array['read', 'write', 'admin'] and cardinality(scopes) > 0),
  created_by text not null default hire.current_actor(),
  created_at timestamptz(3) not null default now(),
  last_used_at timestamptz(3),
  revoked_at timestamptz(3)
);
create index on hire.api_keys (company_id, created_at desc);

-- Jobs ----------------------------------------------------------------------

create table hire.jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references hire.companies on delete cascade,
  title text not null check (length(title) between 1 and 200),
  department text check (length(department) <= 100),
  location text check (length(location) <= 200),
  employment_type text not null default 'full_time'
    check (employment_type in ('full_time', 'part_time', 'contract', 'internship', 'temporary')),
  remote boolean not null default false,
  description text check (length(description) <= 20000),
  status hire.job_status not null default 'open',
  created_at timestamptz(3) not null default now(),
  updated_at timestamptz(3) not null default now(),
  unique (company_id, id)
);
create index on hire.jobs (company_id, created_at desc, id desc);
create trigger jobs_touch before update on hire.jobs
  for each row execute function hire.touch_updated_at();

-- Candidates ----------------------------------------------------------------

create table hire.candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references hire.companies on delete cascade,
  first_name text not null check (length(first_name) between 1 and 100),
  last_name text not null check (length(last_name) between 1 and 100),
  email text not null check (length(email) <= 254),
  phone text check (length(phone) <= 40),
  location text check (length(location) <= 200),
  linkedin_url text check (length(linkedin_url) <= 500),
  source text check (length(source) <= 100),
  created_at timestamptz(3) not null default now(),
  updated_at timestamptz(3) not null default now(),
  unique (company_id, id)
);
create unique index candidates_company_email on hire.candidates (company_id, lower(email));
create index on hire.candidates (company_id, created_at desc, id desc);
create trigger candidates_touch before update on hire.candidates
  for each row execute function hire.touch_updated_at();

create table hire.resumes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  candidate_id uuid not null,
  storage_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  sha256 text not null,
  created_at timestamptz(3) not null default now(),
  foreign key (company_id, candidate_id) references hire.candidates (company_id, id) on delete cascade
);
create index on hire.resumes (company_id, candidate_id, created_at desc);

-- Applications and their stage history -------------------------------------

create table hire.applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  job_id uuid not null,
  candidate_id uuid not null,
  stage hire.stage not null default 'applied',
  rejection_reason text check (length(rejection_reason) <= 500),
  stage_changed_at timestamptz(3) not null default now(),
  created_at timestamptz(3) not null default now(),
  updated_at timestamptz(3) not null default now(),
  unique (job_id, candidate_id),
  -- Composite keys make it impossible to attach another company's job or candidate.
  foreign key (company_id, job_id) references hire.jobs (company_id, id) on delete cascade,
  foreign key (company_id, candidate_id) references hire.candidates (company_id, id) on delete cascade
);
create index on hire.applications (company_id, created_at desc, id desc);
create index on hire.applications (company_id, job_id, stage);
create index on hire.applications (company_id, candidate_id);
create trigger applications_touch before update on hire.applications
  for each row execute function hire.touch_updated_at();

create table hire.stage_history (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  application_id uuid not null references hire.applications on delete cascade,
  from_stage hire.stage,
  to_stage hire.stage not null,
  changed_by text not null,
  note text,
  changed_at timestamptz(3) not null default now()
);
create index on hire.stage_history (application_id, id);

-- Webhooks ------------------------------------------------------------------

create table hire.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references hire.companies on delete cascade,
  url text not null check (length(url) <= 2000),
  description text check (length(description) <= 200),
  events text[] not null default '{application.created,application.stage_changed}',
  secret_ciphertext text not null,
  enabled boolean not null default true,
  created_at timestamptz(3) not null default now(),
  updated_at timestamptz(3) not null default now()
);
create index on hire.webhook_endpoints (company_id);
create trigger webhook_endpoints_touch before update on hire.webhook_endpoints
  for each row execute function hire.touch_updated_at();

create table hire.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references hire.companies on delete cascade,
  endpoint_id uuid not null references hire.webhook_endpoints on delete cascade,
  event_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz(3) not null default now(),
  last_attempt_at timestamptz(3),
  last_status_code integer,
  last_error text,
  delivered_at timestamptz(3),
  created_at timestamptz(3) not null default now()
);
create index on hire.webhook_deliveries (next_attempt_at) where status = 'pending';
create index on hire.webhook_deliveries (endpoint_id, created_at desc);

-- Files waiting to be removed from storage after their rows were deleted.
-- Written in the same transaction as the delete; drained by the API and the
-- maintenance job, so a storage hiccup never strands a résumé.
create table hire.pending_file_deletions (
  storage_path text primary key,
  company_id uuid not null,
  attempts integer not null default 0,
  created_at timestamptz(3) not null default now()
);

-- Audit log (append-only for the API role) ---------------------------------

create table hire.audit_log (
  id bigint generated always as identity primary key,
  company_id uuid not null references hire.companies on delete cascade,
  actor text not null,
  action text not null,
  entity_type text,
  entity_id text,
  request_id text,
  ip text,
  user_agent text,
  metadata jsonb not null default '{}',
  created_at timestamptz(3) not null default now()
);
create index on hire.audit_log (company_id, id desc);

-- Rate limiting (system tables, never touched by hire_app) -----------------

create table hire.rate_limit_counters (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

create or replace function hire.hit_rate_limit(p_bucket text, p_window_seconds integer)
returns table (hits integer, window_start timestamptz)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
begin
  -- Occasionally sweep expired windows so the table stays small.
  if random() < 0.01 then
    delete from hire.rate_limit_counters c where c.window_start < now() - interval '1 day';
  end if;
  return query
    insert into hire.rate_limit_counters as c (bucket, window_start, hits)
    values (p_bucket, v_start, 1)
    on conflict (bucket, window_start) do update set hits = c.hits + 1
    returning c.hits, c.window_start;
end
$$;

-- Triggers: stage history and webhook outbox --------------------------------
-- These run as the schema owner (security definer) so the API role cannot
-- skip, forge or edit history; it can only read it.

create or replace function hire.enqueue_event(p_company uuid, p_type text, p_data jsonb)
returns void
language plpgsql security definer set search_path = hire, pg_temp
as $$
declare
  v_event uuid := gen_random_uuid();
begin
  insert into hire.webhook_deliveries (company_id, endpoint_id, event_id, event_type, payload)
  select e.company_id, e.id, v_event, p_type,
         jsonb_build_object(
           'id', v_event,
           'type', p_type,
           'created_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'company_id', p_company,
           'data', p_data)
  from hire.webhook_endpoints e
  where e.company_id = p_company and e.enabled and p_type = any (e.events);
end
$$;

create or replace function hire.record_stage_change() returns trigger
language plpgsql security definer set search_path = hire, pg_temp
as $$
declare
  v_note text := nullif(current_setting('app.stage_note', true), '');
begin
  if tg_op = 'INSERT' then
    insert into hire.stage_history (company_id, application_id, from_stage, to_stage, changed_by, note)
    values (new.company_id, new.id, null, new.stage, hire.current_actor(), v_note);
    perform hire.enqueue_event(new.company_id, 'application.created', jsonb_build_object(
      'application_id', new.id, 'job_id', new.job_id, 'candidate_id', new.candidate_id,
      'stage', new.stage));
  elsif new.stage is distinct from old.stage then
    new.stage_changed_at := now();
    insert into hire.stage_history (company_id, application_id, from_stage, to_stage, changed_by, note)
    values (new.company_id, new.id, old.stage, new.stage, hire.current_actor(), v_note);
    perform hire.enqueue_event(new.company_id, 'application.stage_changed', jsonb_build_object(
      'application_id', new.id, 'job_id', new.job_id, 'candidate_id', new.candidate_id,
      'from_stage', old.stage, 'to_stage', new.stage, 'note', v_note,
      'rejection_reason', new.rejection_reason));
  end if;
  return new;
end
$$;

create trigger applications_stage_insert after insert on hire.applications
  for each row execute function hire.record_stage_change();
-- BEFORE so the trigger can stamp stage_changed_at on the row itself.
create trigger applications_stage_update before update of stage on hire.applications
  for each row execute function hire.record_stage_change();

-- Row-level security --------------------------------------------------------

alter table hire.companies enable row level security;
create policy own_company on hire.companies for select to hire_app
  using (id = hire.current_company_id());

do $$
declare
  t text;
begin
  foreach t in array array[
    'company_members', 'api_keys', 'jobs', 'candidates', 'resumes', 'applications',
    'stage_history', 'webhook_endpoints', 'webhook_deliveries', 'audit_log', 'pending_file_deletions'
  ] loop
    execute format('alter table hire.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on hire.%I for all to hire_app
         using (company_id = hire.current_company_id())
         with check (company_id = hire.current_company_id())', t);
  end loop;
end
$$;

alter table hire.rate_limit_counters enable row level security; -- no policies: owner only

-- Privileges for the API role ----------------------------------------------

grant select on hire.companies, hire.company_members to hire_app;
grant select, insert, update on hire.api_keys to hire_app;
grant select, insert, update, delete on
  hire.jobs, hire.candidates, hire.resumes, hire.applications, hire.webhook_endpoints
  to hire_app;
grant select on hire.stage_history, hire.webhook_deliveries to hire_app;
grant select, insert on hire.audit_log to hire_app;
grant insert on hire.pending_file_deletions to hire_app;
grant usage on all sequences in schema hire to hire_app;
grant execute on function hire.current_company_id(), hire.current_actor() to hire_app;
revoke execute on function hire.hit_rate_limit(text, integer) from public;
revoke execute on function hire.enqueue_event(uuid, text, jsonb) from public;
