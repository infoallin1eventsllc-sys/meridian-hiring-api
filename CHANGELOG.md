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
- 66 tests against real Postgres, run in GitHub Actions on every push.
