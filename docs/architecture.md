# Lucid Queue architecture

## Goal

One durable job ledger and operations screen for three product backends:

- **CutRank:** physique scans, audits, and rescans.
- **Listvint:** photo enhancement, background removal, price estimates, and listing analysis.
- **ModHorizon:** project and shader generation, plus build validation.

The existing products remain the source of truth for account access, user-uploaded media, billing, model credentials, and product results. Lucid Queue receives a compact job request, dispatches it to a private product processor, and stores status and a small result or result reference.

## Request lifecycle

1. A product's existing server route authenticates the user and checks the product's existing eligibility, quota, and billing rules.
2. The route stores large media privately in that product's existing storage and reserves usage where required.
3. The route sends Lucid Queue a job with a stable idempotency key and a short-lived reference to the private media.
4. Lucid Queue persists the job in D1 and starts a Workflow. Duplicate submissions with the same `(project, idempotencyKey)` return the existing job.
5. The Workflow sends the job to the configured private processor endpoint. The processor calls the existing product logic and deduplicates work by Lucid job ID.
6. The processor returns a small result or a product-owned storage reference. Lucid Queue persists the result and exposes status to the product backend.
7. The product backend settles or refunds the original usage reservation and returns the output to the authenticated user.

Cloudflare Workflows were selected because their steps can retry durably and wait on long network operations without the 15-minute queue-consumer wall-clock limit. Workflows can run for long durations, and individual steps have no wall-clock limit; active CPU limits still apply. Sources: [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) and [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/).

## Service contracts

### Product server to Lucid Queue

- `POST /api/jobs` with a project-specific bearer token.
- `GET /api/jobs/{jobId}` with the same token.
- `POST /api/admin/...` is reserved for the authenticated operations console.
- Requests are idempotent and limited to 200 KB of JSON.
- Image content must remain in product-owned storage. Job payloads may include short-lived signed references, but no raw base64 images.

### Lucid Queue to product processor

`POST {configured processor URL}` with a project-specific bearer token:

```json
{
  "id": "Lucid Queue job ID",
  "project": "listvint",
  "type": "photo.enhance",
  "name": "Photo enhancement",
  "submittedBy": "account reference",
  "payload": { "mediaRef": "product-owned object reference" },
  "attempt": 1
}
```

The product handler returns `{ "result": ... }`. It must use `id` as its idempotency key. Results over 1 MB must stay in product storage; return a compact storage reference instead. A handler failure should use a non-success status and a short, user-safe JSON error.

### Job states

`queued → running → done | failed`; queued jobs can be cancelled. Failed jobs can be retried from the console. Transient dispatch failures are retried three times with exponential delay. Processing must be idempotent because a request can succeed at the product processor while its response is lost before Lucid Queue records completion.

## Security and data boundaries

- Each product has a distinct enqueue token; each processor has a distinct inbound token.
- Tokens and the admin password are environment secrets and are never stored in Git or browser JavaScript.
- The dashboard uses an HTTP-only, strict same-site admin session and origin checks. The deployed dashboard hostname also needs Cloudflare Access before public release.
- Product user IDs are opaque references. Product routes enforce ownership when resolving job results.
- Photos, body scans, clothing images, private prompts, and generated binaries remain in product storage. The queue stores only job metadata, small JSON payloads, and bounded results.
- Logs contain job IDs and bounded safe error messages, never full payloads or credentials.

## Product-specific accounting boundaries

- **CutRank:** its current grade request path validates scan entitlement and marks a paid scan region used only after the grade succeeds. An async adapter must retain those rules when the job is submitted and completed; a queue retry must not consume another scan.
- **Listvint:** current AI routes reserve usage before provider calls and finalize the reservation with the provider result. A queued job must keep the reservation ID with the private product-side job record and finalize it exactly once after completion or failure.
- **ModHorizon:** current generation reserves credits before AI generation and settles or refunds them around provider outcomes. The queue adapter must carry an idempotent generation ID so workflow retries do not charge twice; the existing build and ownership checks must still run.

These are integration constraints from the existing product code. The queue must not bypass them or make its D1 job status the source of truth for product entitlements.

## Current integration boundary

The queue service and dashboard are being built first. The three product adapters are not wired yet. Each adapter must refactor its existing synchronous operation into an idempotent private processor route and update its user-facing route to submit a job, poll status, and settle existing usage/billing state. Live integration is incomplete until those changes are deployed with matching secrets and private processor URLs.
