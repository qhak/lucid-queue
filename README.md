# Lucid Queue

Lucid Queue is the shared, asynchronous job service for CutRank, Listvint, and ModHorizon. Product servers authenticate with their own token, create an idempotent job, and read its status and result. A durable Cloudflare Workflow dispatches the job to that product's private processor endpoint, records progress, and retries transient failures.

The dashboard is an authenticated operations console. It reads persisted job state, shows actual workflow activity, lets an operator pause new work, and can retry failed jobs. No sample jobs are seeded.

## Local development

Requirements: Node.js 22.13 or later.

1. Install dependencies: `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and set local passwords/tokens.
3. Set the three processor URLs to private local adapter routes. The adapters are part of the product integrations and must use the existing product logic.
4. Start the local service: `npm run dev`
5. Open `http://localhost:8795` and sign in with `LUCID_ADMIN_PASSWORD`.

The `dev` command applies the D1 migration to Wrangler's local database before starting the Worker. The local database and Workflows state are under `.wrangler/` and are ignored by Git.

## Site integration contract

Product backends submit requests to `POST /api/jobs` with `Authorization: Bearer <project-token>` and JSON containing:

```json
{
  "name": "Photo enhancement",
  "type": "photo.enhance",
  "submittedBy": "account reference",
  "idempotencyKey": "stable request id",
  "payload": { "mediaRef": "short-lived product-storage reference" }
}
```

The API returns `202` and a `jobId`. The product backend can poll `GET /api/jobs/{jobId}` with the same project token. A status of `done` includes the processor result; `failed` includes a bounded error. Product handlers must deduplicate by the Lucid job ID and attempt because the workflow can retry a request after a network failure. A processor can finish synchronously or return `202` with a same-origin HTTPS `statusUrl` for durable polling of longer jobs.

Job payloads contain references to the products' private media storage, never raw photos, data URLs, account credentials, or secrets. The product app remains responsible for user authentication, authorization, usage limits, billing reservations, private image storage, and returning large results to the user. Lucid Queue coordinates processing and keeps the shared job history.

See [the architecture and integration plan](docs/architecture.md) for job types, the processor contract, and deployment steps.

## Deployment

The production Worker is live at [`lucid-queue.callout-ai.workers.dev`](https://lucid-queue.callout-ai.workers.dev). Its EU D1 database and initial schema are provisioned. An unauthenticated `POST /api/jobs` is rejected; no product is submitting jobs yet.

This is an early production deployment, not a completed multi-product integration. Listvint's queue adapter code is deployed with its feature flag off. CutRank and ModHorizon adapter code is prepared but not deployed. Before enabling jobs, configure the project and processor tokens, processor URLs, admin password and session secret, and protect the operations dashboard with Cloudflare Access. Listvint also needs its Supabase migration and private storage bucket. Cloudflare R2 must be enabled before provisioning the private CutRank media and ModHorizon artifact buckets.

## Project layout

- `public/` — operations dashboard
- `src/index.ts` — authenticated API and static asset routing
- `src/workflow.ts` — durable dispatch, retry, and result persistence
- `migrations/` — D1 job ledger and activity schema
- `docs/architecture.md` — integration and security boundaries

## License

MIT. See [LICENSE](LICENSE).
