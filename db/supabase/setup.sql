-- Supabase-only setup, run once per project after `npm run db:migrate`.
-- (Tests run on plain Postgres and skip this file.)
--
-- Replace the placeholders before running:
--   __APP_DB_PASSWORD__  a long random password for the API's own login (step 3),
--                        e.g. openssl rand -hex 24. It goes into DATABASE_URL and nowhere else.
--   __PUBLIC_BASE_URL__  e.g. https://meridian-hire.vercel.app (step 2 only)
-- Step 2 is only for hosts without Vercel Cron. Its secret is generated here,
-- kept in Vault and checked by the API against Vault.

-- 0. The hire schema is only ever reached through the API, never Supabase's Data API.
revoke all on schema hire, hire_meta from anon, authenticated;
revoke all on all tables in schema hire from anon, authenticated;

-- 1. Private bucket for résumés and project files: 4 MB cap, never public.
--    Résumés: PDF and Word. Project files: ZIP, PDF, PNG and JPEG.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 4194304, array[
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
  'image/png',
  'image/jpeg'
])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 2. Every minute, ask the API to send due webhooks and tidy up expired sandboxes.
--    Skip this step when the API runs on Vercel: vercel.json schedules the same call with
--    Vercel Cron, using the CRON_SECRET environment variable.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'hire_cron_secret', 'Bearer token for /internal/tick')
where not exists (select 1 from vault.secrets where name = 'hire_cron_secret');

select cron.schedule(
  'meridian-hire-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := '__PUBLIC_BASE_URL__/internal/tick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'hire_cron_secret'),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 25000
  );
  $$
);

-- 3. The API's own database login. DATABASE_URL uses it instead of postgres:
--      postgresql://meridian_api.<project-ref>:__APP_DB_PASSWORD__@<pooler-host>:6543/postgres
--    It can use the hiring tables and nothing else in the project. BYPASSRLS is for the few
--    queries that run before a company is known (API key lookup, sandbox creation, the
--    every-minute job); every company-scoped request drops to hire_app with SET LOCAL ROLE
--    (src/db.ts), and row-level security applies to hire_app. It has no Vault access: on
--    Vercel the every-minute job is authorised by CRON_SECRET instead.
--    Undo: drop owned by meridian_api; drop role meridian_api;
create role meridian_api with login bypassrls password '__APP_DB_PASSWORD__' connection limit 40;
comment on role meridian_api is 'Meridian Hire API. Owns nothing; data access only.';
grant hire_app to meridian_api;
grant usage on schema hire, hire_meta to meridian_api;
grant select, insert, update, delete on all tables in schema hire, hire_meta to meridian_api;
grant usage, select on all sequences in schema hire, hire_meta to meridian_api;
grant execute on all functions in schema hire to meridian_api;
-- Tables and functions added by later migrations (run as postgres) are covered too.
alter default privileges for role postgres in schema hire grant select, insert, update, delete on tables to meridian_api;
alter default privileges for role postgres in schema hire grant usage, select on sequences to meridian_api;
alter default privileges for role postgres in schema hire grant execute on functions to meridian_api;
