# Changelog

## 0.1.0 (unreleased)

Phase 1: the portfolio-grade MVP.

Apply page (9 Nov 2026):

- Every open job has a public apply page (`/apply/<job id>`). Candidates apply themselves, with no account: their details, résumé, LinkedIn, GitHub profile, a project they built (repository, live link, file) and a message to the hiring team. The application lands in Applied with source "careers page", and the stage history shows it came from the apply page.
- New endpoints that need no key: `GET /v1/public/jobs/{id}` and `POST /v1/public/jobs/{id}/applications`. Applying returns a 30-minute upload token that can send one résumé (`POST /v1/public/uploads/resume`) and one project file (`POST /v1/public/uploads/project-file`), nothing else. Drafts, and jobs of expired sandboxes, don't exist to the public; closed jobs say so.
- Guarded by Vercel BotID, 10 applications an hour per network, the employer's own rate limit and sandbox caps, and explicit consent to share the application.
- The board has an "Apply pages" panel with each open job's link (open or copy), and refreshes itself when you come back to its tab.
- Application creation, résumé storage and project files are now shared functions, so the API and the apply page follow exactly the same rules.

GitHub and projects (9 Nov 2026):

- Candidates can share their GitHub profile (`github_url`) when they apply, so the hiring team can look at the code they write.
- New **projects** for each candidate: a name, what it is, the GitHub repository, a live link and an optional file (a ZIP of the code, a PDF or a PNG/JPEG screenshot, up to 4 MB; 2 MB in a sandbox). Files are checked by their contents, stored privately and opened through five-minute links; ZIPs are never unpacked. Endpoints: `POST/GET /v1/candidates/{id}/projects`, `PATCH/DELETE /v1/projects/{id}`, `POST /v1/projects/{id}/file`, `GET /v1/projects/{id}/download`.
- The board's "Add a candidate" form takes a GitHub profile and a project. The candidate panel shows the GitHub link, each project with "View code on GitHub", the live site and the file, and lets the team add a GitHub profile or a project later.
- Erasing a candidate also removes their projects and project files; expired sandboxes clean up project files too.
- The sandbox storage cap (20 MB) now covers résumés and project files together; its 409 reports `quota: "file_bytes"` (was `resume_bytes`).
- Migration `0004_github_and_projects.sql`. On Supabase, the private bucket now also accepts ZIP, PNG and JPEG (see `db/supabase/setup.sql`).

Fixes from the 4 Nov 2026 diagnostic:

- Reading now needs the `read` scope, so a write-only key can't list candidates. `GET /v1/me` stays open to every key.
- Pausing a webhook endpoint also holds its queued retries. "Send a test event" sends just that event, and a whole send is capped at 8 seconds, not only quiet sockets.
- Erasing a candidate deletes the webhook deliveries about them, which can carry the recruiter's note.
- Sandbox caps hold under parallel requests (each company's capped writes take a lock), and résumé caps are checked again after the upload. Reusing a candidate by email no longer counts against the candidate cap. A résumé for a candidate erased mid-upload returns 404.
- Sample candidates now exist before their first application. The maintenance job clears the file queue once per run, not twice.
- The board fetches only the applications when filters or search change, so a busy visitor stays well inside the rate limit, and an older search can't overwrite a newer one. An expired sandbox returns to the welcome screen. A stage button re-enables when a move fails. Under an hour left reads "under an hour".
- The API docs list the 409s that job, key and résumé creation can return, the extra fields errors carry (`allowed`, `existing_id`, `quota`, `retry_after` and more), the sandbox's 1 MB résumé limit, and no 401 on sandbox creation. Webhook endpoints list newest first, like every other list.
- Local dev serves résumé links (`npm run dev:local`). A robots.txt keeps the API out of search engines.

- Jobs, candidates and applications with search, filters and cursor pagination.
- Pipeline rules (Applied → Screen → Interview → Offer → Hired / Rejected) with a stage history written by database triggers.
- Multi-company isolation through Postgres row-level security, per-company API keys with scopes, and Supabase logins with roles.
- Résumé uploads to private storage, checked by file contents, with five-minute download links.
- Signed webhooks with retries, a delivery log and an SSRF guard.
- Per-company rate limits, an append-only audit log, and one error shape (RFC 9457) everywhere.
- Candidate erasure for privacy requests, including queued file deletion that survives a storage outage.
- Self-serve 24-hour sandboxes seeded with sample data, a pipeline board, and interactive OpenAPI docs.
- Abuse limits for public sandboxes: caps on records, files and daily changes, per-network and global creation limits, and webhook targets locked to test receivers.
- 94 tests against real Postgres, run in GitHub Actions on every push.
- Vercel deploy fixes: the entry file imports Hono directly, which Vercel needs to recognise the app, and / redirects to the pipeline board.
- The Meridian Interface mark and name in the header, browser tab and docs, replacing the placeholder icon.
- Webhook retries and sandbox clean-up run every minute on Vercel Cron, authorised with `CRON_SECRET`.
- The board can add a candidate with a résumé, upload or open a résumé, and erase a candidate, with a four-step guide that ticks off as visitors try each part.
- Bot protection (Vercel BotID) on sandbox creation, checked before any rate-limit allowance is used; at most 200 active sandboxes.
- Fix: the API docs page was blank on Vercel, because files a build step writes into `public/` are not published. The docs viewer now loads from jsDelivr, pinned to one version with an integrity hash, and the small BotID script is committed (a test checks it matches a fresh build).
- The welcome page shows what Meridian Hire becomes with a pilot or custom build (team logins, careers page, emails and scheduling, feedback and reports, tool connections, agency mode) and links to Meridian Interface. The add-candidate form explains mistakes in plain English and marks the fields to fix. No accessibility violations (axe) on the board, candidate panel and form, in light and dark mode.
- Dependabot groups minor and patch updates and skips major versions that need their own review (embedded-postgres tracks Supabase's Postgres 17, @types/node tracks Node 22, the postgres driver, TypeScript). Lighthouse scores for the live demo in the README.
- Link previews (Open Graph) for the demo, a live-demo check every three hours that emails on failure, and a plainer message when bot protection turns a request away.
- The sample company is now "Meridian Interface Staffing"; screenshots and the link-preview picture updated to match.
- The API's own database login (`meridian_api`) is in `db/supabase/setup.sql`; security headers now match between the API and static files, and the board's CSP allows no inline styles.
