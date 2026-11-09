-- Candidates can share their GitHub profile and the projects they've built, so
-- the hiring team can look at real work, not just a résumé.

alter table hire.candidates add column github_url text check (length(github_url) <= 500);

create table hire.projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  candidate_id uuid not null,
  title text not null check (length(title) between 1 and 200),
  description text check (length(description) <= 2000),
  repo_url text check (length(repo_url) <= 500),
  live_url text check (length(live_url) <= 500),
  -- The optional file (a ZIP of the code, a PDF case study or a screenshot).
  -- Either every file column is set or none is.
  storage_path text unique,
  file_name text check (length(file_name) between 1 and 255),
  content_type text,
  size_bytes integer check (size_bytes > 0),
  sha256 text,
  created_at timestamptz(3) not null default now(),
  updated_at timestamptz(3) not null default now(),
  check (num_nulls(storage_path, file_name, content_type, size_bytes, sha256) in (0, 5)),
  foreign key (company_id, candidate_id) references hire.candidates (company_id, id) on delete cascade
);
create index on hire.projects (company_id, candidate_id, created_at desc);
create trigger projects_touch before update on hire.projects
  for each row execute function hire.touch_updated_at();

alter table hire.projects enable row level security;
create policy tenant_isolation on hire.projects for all to hire_app
  using (company_id = hire.current_company_id())
  with check (company_id = hire.current_company_id());

grant select, insert, update, delete on hire.projects to hire_app;

-- On Supabase, keep the table out of reach of the Data API roles, like every other hire table.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on hire.projects from anon, authenticated;
  end if;
end
$$;
