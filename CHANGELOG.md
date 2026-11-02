# Changelog

## 0.4.0 — 2026-11-02

- Added durable polling for private product processors that acknowledge long-running work with HTTP 202.
- Validate processor status URLs as same-origin HTTPS endpoints, bound response bodies, and retain compatibility with existing synchronous processors.
- Documented the async processor contract used by CutRank, Listvint, and ModHorizon adapters.
- Verified a local mock processor through multiple durable status polls, then TypeScript and Wrangler deployment dry-run checks.

## 0.3.0 — 2026-11-01

- Reworked the processing pipeline so stage labels and live job counts stay inside their connectors at desktop and narrow widths.
- Added GitHub Actions checks for TypeScript and the Cloudflare Worker deployment bundle.
- Confirmed the queue core is deployable, while live CutRank, Listvint, and ModHorizon adapters still need to be connected and configured.

## 0.2.0 — 2026-11-01

- Replaced the in-memory demo with a Cloudflare Worker API, durable Workflows, and a D1 job ledger.
- Added per-product credentials, idempotent job submission, status polling, admin sessions, pause/resume, retry, and cancellation for queued jobs.
- Added truthful processor setup status and reject jobs when their private handler is not configured.
- Added the integration and privacy contract for CutRank, Listvint, and ModHorizon.
- Verified local authentication, unauthorized producer rejection, no-handler rejection, a local end-to-end Workflow dispatch, TypeScript, Wrangler dry-run, and dependency audit.

## 0.1.0 — 2026-11-01

- Created the initial Lucid Queue dashboard concept and local interaction prototype.
