import { JobWorkflow } from "./workflow";
import type { Env, JobRow, ProjectId } from "./types";

export { JobWorkflow };

const JOB_TYPES: Record<ProjectId, string[]> = {
  cutrank: ["physique.scan", "physique.audit", "physique.rescan"],
  listvint: ["photo.enhance", "photo.remove-background", "price.estimate", "listing.analysis"],
  modhorizon: ["project.generate", "shader.generate", "build.validate"],
};
const PROJECT_TOKENS: Record<ProjectId, keyof Env> = {
  cutrank: "LUCID_CUTRANK_TOKEN",
  listvint: "LUCID_LISTVINT_TOKEN",
  modhorizon: "LUCID_MODHORIZON_TOKEN",
};
const PROCESSOR_CONFIG: Record<ProjectId, { url: keyof Env; token: keyof Env }> = {
  cutrank: { url: "CUTRANK_PROCESSOR_URL", token: "CUTRANK_PROCESSOR_TOKEN" },
  listvint: { url: "LISTVINT_PROCESSOR_URL", token: "LISTVINT_PROCESSOR_TOKEN" },
  modhorizon: { url: "MODHORIZON_PROCESSOR_URL", token: "MODHORIZON_PROCESSOR_TOKEN" },
};
const SESSION_COOKIE = "lucid_admin";
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_BODY_BYTES = 200_000;

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return origin === new URL(env.APP_ORIGIN).origin && origin === new URL(request.url).origin;
}

function projectFromToken(request: Request, env: Env): ProjectId | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  if (!match) return null;
  for (const [project, key] of Object.entries(PROJECT_TOKENS) as [ProjectId, keyof Env][]) {
    if (constantTimeEqual(match[1], String(env[key] || ""))) return project;
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i += 1) difference |= (a[i % a.length] || 0) ^ (b[i % b.length] || 0);
  return difference === 0;
}

async function parseJson(request: Request, limit = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw new RangeError("Request body is too large.");
  const value: unknown = JSON.parse(text);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cookieValue(request: Request, key: string): string | null {
  const cookie = request.headers.get("Cookie") || "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`));
  return entry ? decodeURIComponent(entry.slice(key.length + 1)) : null;
}

function base64url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch { return null; }
}

async function signSession(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}

async function hasAdminSession(request: Request, env: Env): Promise<boolean> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !env.LUCID_SESSION_SECRET || env.LUCID_SESSION_SECRET.length < 32) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  const bytes = fromBase64url(payload);
  if (!bytes) return false;
  const expected = await signSession(payload, env.LUCID_SESSION_SECRET);
  if (!constantTimeEqual(signature, expected)) return false;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: number };
    return typeof value.exp === "number" && value.exp > Date.now();
  } catch { return false; }
}

function cookieOptions(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  if (!await hasAdminSession(request, env)) return json({ error: "Sign in to Lucid Queue first." }, 401);
  if (request.method !== "GET" && !sameOrigin(request, env)) return json({ error: "Origin check failed." }, 403);
  return null;
}

async function listAdminState(env: Env): Promise<Response> {
  const [jobs, activity, counts, setting] = await Promise.all([
    env.DB.prepare("SELECT id, project, name, type, status, submitted_by, error, attempts, created_at, started_at, completed_at FROM jobs ORDER BY created_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT id, job_id, project, kind, message, created_at FROM activity ORDER BY id DESC LIMIT 12").all(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all<{ status: string; count: number }>(),
    env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first<{ value: string }>(),
  ]);
  const totals: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const row of counts.results || []) totals[row.status] = row.count;
  const processors = Object.entries(PROCESSOR_CONFIG).map(([project, keys]) => ({
    project,
    configured: Boolean(env[keys.url] && env[keys.token]),
  }));
  return json({ jobs: jobs.results || [], activity: activity.results || [], totals, paused: setting?.value === "true", projects: Object.keys(JOB_TYPES), processors });
}

async function handleCreateJob(request: Request, env: Env, admin = false): Promise<Response> {
  const authenticatedProject = admin ? null : projectFromToken(request, env);
  if (!admin && !authenticatedProject) return json({ error: "Project authentication failed." }, 401);
  let body: Record<string, unknown> | null;
  try { body = await parseJson(request); }
  catch (error) {
    return error instanceof RangeError
      ? json({ error: error.message }, 413)
      : json({ error: "Request body must contain valid JSON." }, 400);
  }
  if (!body) return json({ error: "Send a JSON object." }, 400);

  const project = authenticatedProject || (typeof body.project === "string" ? body.project as ProjectId : null);
  if (!project || !Object.hasOwn(JOB_TYPES, project)) return json({ error: "Select one of the configured projects." }, 400);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const type = typeof body.type === "string" ? body.type : "";
  const submitter = typeof body.submittedBy === "string" ? body.submittedBy.trim().slice(0, 120) : null;
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim().slice(0, 120) : "";
  const payload = body.payload;
  if (!name) return json({ error: "Job name is required." }, 400);
  if (!JOB_TYPES[project].includes(type)) return json({ error: `Job type is not enabled for ${project}.`, allowedTypes: JOB_TYPES[project] }, 400);
  const processorKeys = PROCESSOR_CONFIG[project];
  if (!env[processorKeys.url] || !env[processorKeys.token]) return json({ error: `The private ${project} processor is not configured yet.` }, 503);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ error: "Job payload must be a JSON object." }, 400);
  if (!idempotencyKey) return json({ error: "An idempotencyKey is required so request retries cannot create duplicate work." }, 400);
  if (containsInlineImage(payload)) return json({ error: "Upload media to the product's private storage and send a short-lived reference; image bytes cannot be placed in the queue payload." }, 400);

  const existing = await env.DB.prepare("SELECT id, status, created_at FROM jobs WHERE project=? AND idempotency_key=?")
    .bind(project, idempotencyKey).first<{ id: string; status: string; created_at: string }>();
  if (existing) return json({ jobId: existing.id, status: existing.status, createdAt: existing.created_at, duplicate: true }, 200);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO jobs(id, project, name, type, status, submitted_by, idempotency_key, payload_json, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
    ).bind(id, project, name, type, submitter, idempotencyKey, JSON.stringify(payload), createdAt).run();
  } catch (error) {
    const raced = await env.DB.prepare("SELECT id, status, created_at FROM jobs WHERE project=? AND idempotency_key=?")
      .bind(project, idempotencyKey).first<{ id: string; status: string; created_at: string }>();
    if (raced) return json({ jobId: raced.id, status: raced.status, createdAt: raced.created_at, duplicate: true }, 200);
    console.error("Queue job insert failed", error);
    return json({ error: "Could not record the job." }, 503);
  }

  await env.DB.prepare("INSERT INTO activity(job_id, project, kind, message, created_at) VALUES (?, ?, 'queued', ?, ?)")
    .bind(id, project, `${name} added to the queue`, createdAt).run();
  try {
    const instance = await env.JOB_RUNNER.create({ id, params: { jobId: id } });
    await env.DB.prepare("UPDATE jobs SET workflow_id=? WHERE id=?").bind(instance.id, id).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job runner could not start.";
    await env.DB.prepare("UPDATE jobs SET status='failed', error=?, completed_at=? WHERE id=?")
      .bind(message.slice(0, 500), new Date().toISOString(), id).run();
    await env.DB.prepare("INSERT INTO activity(job_id, project, kind, message, created_at) VALUES (?, ?, 'failed', ?, ?)")
      .bind(id, project, `${name} could not start`, new Date().toISOString()).run();
    console.error("Queue workflow launch failed", error);
    return json({ error: "Job was recorded but the processor could not start.", jobId: id }, 503);
  }

  return json({ jobId: id, status: "queued", statusUrl: `/api/jobs/${id}`, createdAt }, 202);
}

function containsInlineImage(value: unknown): boolean {
  if (typeof value === "string") return /^data:image\//i.test(value) || value.length > 150_000;
  if (Array.isArray(value)) return value.some(containsInlineImage);
  if (value && typeof value === "object") return Object.values(value).some(containsInlineImage);
  return false;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health" && request.method === "GET") return json({ ok: true, service: "lucid-queue" });

  if (path === "/api/admin/login" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json({ error: "Origin check failed." }, 403);
    const body = await parseJson(request, 4096).catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!env.LUCID_ADMIN_PASSWORD || env.LUCID_ADMIN_PASSWORD.length < 24) return json({ error: "Configure an admin password with at least 24 characters." }, 503);
    if (!constantTimeEqual(password, env.LUCID_ADMIN_PASSWORD || "")) return json({ error: "Password was not accepted." }, 401);
    if (!env.LUCID_SESSION_SECRET || env.LUCID_SESSION_SECRET.length < 32) return json({ error: "Set a session secret of at least 32 characters." }, 503);
    const payload = base64url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + SESSION_SECONDS * 1000 })));
    const signature = await signSession(payload, env.LUCID_SESSION_SECRET);
    return json({ ok: true }, 200, { "Set-Cookie": cookieOptions(request, `${payload}.${signature}`, SESSION_SECONDS) });
  }

  if (path === "/api/admin/logout" && request.method === "POST") {
    if (!sameOrigin(request, env)) return json({ error: "Origin check failed." }, 403);
    return json({ ok: true }, 200, { "Set-Cookie": cookieOptions(request, "", 0) });
  }

  if (path === "/api/admin/session" && request.method === "GET") {
    return json({ authenticated: await hasAdminSession(request, env) });
  }

  if (path === "/api/admin/state" && request.method === "GET") {
    const authFailure = await requireAdmin(request, env);
    return authFailure || listAdminState(env);
  }

  if (path === "/api/admin/jobs" && request.method === "POST") {
    const authFailure = await requireAdmin(request, env);
    return authFailure || handleCreateJob(request, env, true);
  }

  if (path === "/api/admin/queue/pause" && request.method === "POST") {
    const authFailure = await requireAdmin(request, env);
    if (authFailure) return authFailure;
    await env.DB.prepare("UPDATE settings SET value='true' WHERE key='paused'").run();
    return json({ paused: true });
  }

  if (path === "/api/admin/queue/resume" && request.method === "POST") {
    const authFailure = await requireAdmin(request, env);
    if (authFailure) return authFailure;
    await env.DB.prepare("UPDATE settings SET value='false' WHERE key='paused'").run();
    return json({ paused: false });
  }

  const adminAction = /^\/api\/admin\/jobs\/([0-9a-f-]+)\/(retry|cancel)$/.exec(path);
  if (adminAction && request.method === "POST") {
    const authFailure = await requireAdmin(request, env);
    if (authFailure) return authFailure;
    const [, id, action] = adminAction;
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<JobRow>();
    if (!row) return json({ error: "Job not found." }, 404);
    if (action === "cancel") {
      if (row.status !== "queued") return json({ error: "Only queued jobs can be cancelled." }, 409);
      await env.DB.prepare("UPDATE jobs SET status='cancelled', completed_at=? WHERE id=? AND status='queued'").bind(new Date().toISOString(), id).run();
      await env.DB.prepare("INSERT INTO activity(job_id, project, kind, message, created_at) VALUES (?, ?, 'cancelled', ?, ?)").bind(id, row.project, `${row.name} cancelled`, new Date().toISOString()).run();
      return json({ jobId: id, status: "cancelled" });
    }
    if (row.status !== "failed") return json({ error: "Only failed jobs can be retried." }, 409);
    const attempt = row.attempts + 1;
    const workflowId = `${id}-retry-${attempt}`;
    await env.DB.prepare("UPDATE jobs SET status='queued', error=NULL, result_json=NULL, completed_at=NULL, workflow_id=? WHERE id=?")
      .bind(workflowId, id).run();
    try {
      await env.JOB_RUNNER.create({ id: workflowId, params: { jobId: id } });
    } catch (error) {
      await env.DB.prepare("UPDATE jobs SET status='failed', error=? WHERE id=?").bind("Could not restart the job workflow.", id).run();
      console.error("Queue job retry failed", error);
      return json({ error: "Could not restart the job." }, 503);
    }
    await env.DB.prepare("INSERT INTO activity(job_id, project, kind, message, created_at) VALUES (?, ?, 'retry', ?, ?)").bind(id, row.project, `${row.name} queued for retry`, new Date().toISOString()).run();
    return json({ jobId: id, status: "queued" });
  }

  if (path === "/api/jobs" && request.method === "POST") return handleCreateJob(request, env);

  const jobMatch = /^\/api\/jobs\/([0-9a-f-]+)$/.exec(path);
  if (jobMatch && request.method === "GET") {
    const project = projectFromToken(request, env);
    if (!project) return json({ error: "Project authentication failed." }, 401);
    const row = await env.DB.prepare("SELECT id, project, name, type, status, result_json, error, attempts, created_at, started_at, completed_at FROM jobs WHERE id=? AND project=?")
      .bind(jobMatch[1], project).first<JobRow>();
    if (!row) return json({ error: "Job not found." }, 404);
    return json({ ...row, result: row.result_json ? JSON.parse(row.result_json) : null, result_json: undefined });
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); }
    catch (error) {
      console.error("Lucid Queue request failed", error);
      return json({ error: "Lucid Queue could not complete the request." }, 500);
    }
  },
};
