# Meridian Hire: roadmap

Two phases. Phase 1 is a portfolio piece built on foundations a paying product needs. Phase 2 adds what's needed to sell it to recruiting firms.

## Phase 1: built

Everything in the README's "What it does" list. It was designed so that Phase 2 doesn't need a rewrite:

- Every table is keyed by company and isolated by row-level security, so adding customers is adding rows.
- Companies already have a `plan` (`sandbox`, `starter`, `team`, `agency`), and rate limits already read from it, so billing plugs into one place.
- Logins and roles (`owner`, `admin`, `recruiter`, `viewer`) already work through Supabase Auth; only the sign-up and invite screens are missing.
- Candidate erasure, file-deletion queuing and ids-only webhook payloads are in place for privacy requests.

## Phase 2: to sell it

### Billing and plans

- Stripe Checkout and the Customer Portal for plan changes, with a webhook that updates `companies.plan`.
- Plan limits beyond request rate: active jobs, seats and résumé storage. They'd be enforced in the API, and the error would say which limit was hit.
- Usage shown in the dashboard, plus a 14-day trial.

### Onboarding

- Self-serve sign-up: create a company, verify email, invite teammates by role, and create the first API key with a copy-once screen.
- A short "first webhook" guide, using the existing test-event endpoint.
- An idempotency-key header on writes, so a firm's retries never create duplicates.

### Legal (needs a lawyer's review before taking money)

- Terms of service, a privacy policy and a data processing agreement for clients. I can draft them from templates.
- A subprocessor list (Vercel, Supabase, Stripe) and a security page.

### Candidate personal data

- **Retention:** each company picks how long to keep closed applications (for example 12 or 24 months). A nightly job deletes or anonymises what has passed its date, using the same erasure path as today.
- **Access and export:** `GET /v1/candidates/{id}/export` returns everything held about a person as JSON plus their files, for access requests.
- **Consent:** record the version of the privacy notice a candidate saw when they applied.
- **The record-keeping tension:** US employers generally must keep application records for about a year (EEOC rules), while state laws such as California's CCPA/CPRA give applicants deletion and access rights. The product should let each firm set a retention floor and log refused deletions with the reason. A lawyer should confirm the defaults.
- **No automated decisions:** no AI scoring or ranking of candidates. That keeps the product clear of rules such as New York City's Local Law 144 on automated hiring tools.

### Running it as a business

- Supabase Pro ($25/month) for daily backups and no idle pausing. Vercel Pro ($20/month), because the free Hobby plan doesn't allow commercial use.
- A custom domain, error tracking, uptime alerts, and a status page.
- The pre-delivery security check before any client goes live, plus a short penetration-test pass.
