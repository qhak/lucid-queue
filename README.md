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

The API returns `202` and a `jobId`. The product backend can poll `GET /api/jobs/{jobId}` with the same project token. A status of `done` includes the processor result; `failed` includes a bounded error. Product handlers must deduplicate by `id` because the workflow can retry a request after a network failure.

Job payloads contain references to the products' private media storage, never raw photos, data URLs, account credentials, or secrets. The product app remains responsible for user authentication, authorization, usage limits, billing reservations, private image storage, and returning large results to the user. Lucid Queue coordinates processing and keeps the shared job history.

See [the architecture and integration plan](docs/architecture.md) for job types, the processor contract, and deployment steps.

## Deployment

The service targets Cloudflare Workers and Workflows with D1. Before deployment, create a D1 database, update the database ID in `wrangler.jsonc`, configure the product tokens and private processor endpoints as Worker secrets, and protect the dashboard hostname with Cloudflare Access. Add each site's queue token and endpoint to that site's server environment. Local code is prepared for this deployment; no Cloudflare account resources or live sites have been changed by this project yet.

## Project layout

- `public/` — operations dashboard
- `src/index.ts` — authenticated API and static asset routing
- `src/workflow.ts` — durable dispatch, retry, and result persistence
- `migrations/` — D1 job ledger and activity schema
- `docs/architecture.md` — integration and security boundaries

## License

MIT. See [LICENSE](LICENSE).
