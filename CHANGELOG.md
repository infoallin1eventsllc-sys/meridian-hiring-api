# Changelog

## 0.1.0 (unreleased)

Phase 1: the portfolio-grade MVP.

- Jobs, candidates and applications with search, filters and cursor pagination.
- Pipeline rules (Applied → Screen → Interview → Offer → Hired / Rejected) with a stage history written by database triggers.
- Multi-company isolation through Postgres row-level security, per-company API keys with scopes, and Supabase logins with roles.
- Résumé uploads to private storage, checked by file contents, with five-minute download links.
- Signed webhooks with retries, a delivery log and an SSRF guard.
- Per-key rate limits, an append-only audit log, and one error shape (RFC 9457) everywhere.
- Candidate erasure for privacy requests, including queued file deletion that survives a storage outage.
- Self-serve 24-hour sandboxes seeded with sample data, a pipeline board, and interactive OpenAPI docs.
- Abuse limits for public sandboxes: caps on records, files and daily changes, per-network and global creation limits, and webhook targets locked to test receivers.
- 71 tests against real Postgres, run in GitHub Actions on every push.
- Vercel deploy fixes: the entry file imports Hono directly, which Vercel needs to recognise the app, and / redirects to the pipeline board.
- The Meridian Interface mark and name in the header, browser tab and docs, replacing the placeholder icon.
- Webhook retries and sandbox clean-up run every minute on Vercel Cron, authorised with `CRON_SECRET`.
- The board can add a candidate with a résumé, upload or open a résumé, and erase a candidate, with a four-step guide that ticks off as visitors try each part.
- Bot protection (Vercel BotID) on sandbox creation, checked before any rate-limit allowance is used; at most 200 active sandboxes.
- Fix: the API docs page was blank on Vercel, because files a build step writes into `public/` are not published. The docs viewer now loads from jsDelivr, pinned to one version with an integrity hash, and the small BotID script is committed (a test checks it matches a fresh build).
- The welcome page shows what Meridian Hire becomes with a pilot or custom build (team logins, careers page, emails and scheduling, feedback and reports, tool connections, agency mode) and links to Meridian Interface. The add-candidate form explains mistakes in plain English and marks the fields to fix. No accessibility violations (axe) on the board, candidate panel and form, in light and dark mode.
- Dependabot groups minor and patch updates and skips major versions that need their own review (embedded-postgres tracks Supabase's Postgres 17, @types/node tracks Node 22, the postgres driver, TypeScript). Lighthouse scores for the live demo in the README.
- The API's own database login (`meridian_api`) is in `db/supabase/setup.sql`; security headers now match between the API and static files, and the board's CSP allows no inline styles.
