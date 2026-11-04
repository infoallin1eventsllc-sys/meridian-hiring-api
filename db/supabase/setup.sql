-- Supabase-only setup, run once per project after `npm run db:migrate`.
-- (Tests run on plain Postgres and skip this file.)
--
-- Replace the placeholder before running:
--   __PUBLIC_BASE_URL__  e.g. https://meridian-hire.vercel.app
-- The cron secret is generated here, kept in Vault, and checked by the API
-- against Vault, so nobody has to copy it anywhere.

-- 0. The hire schema is only ever reached through the API, never Supabase's Data API.
revoke all on schema hire, hire_meta from anon, authenticated;
revoke all on all tables in schema hire from anon, authenticated;

-- 1. Private bucket for résumés: 4 MB cap, PDF and Word only, never public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 4194304, array[
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
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
