import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, JobParams, JobRow, ProjectId } from "./types";

const MAX_RESULT_BYTES = 1_000_000;
const MAX_PROCESSOR_POLLS = 5_000;

type ProcessorState =
  | { status: "queued" | "running"; statusUrl: string; retryAfterSeconds: number }
  | { status: "done"; resultJson: string }
  | { status: "failed"; error: string };

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESULT_BYTES) {
      await reader.cancel();
      throw new Error("Processor response exceeds the 1 MB limit; return a product-owned storage reference instead.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function processorStatusUrl(value: unknown, processorUrl: string): string {
  if (typeof value !== "string" || value.length > 2_000) throw new Error("Processor did not provide a valid status URL.");
  const configured = new URL(processorUrl);
  const status = new URL(value, configured);
  const localHttp = status.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(status.hostname);
  if ((!localHttp && status.protocol !== "https:") || status.origin !== configured.origin || status.username || status.password) {
    throw new Error("Processor status URL must use HTTPS and the configured processor origin.");
  }
  return status.toString();
}

function retryDelay(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(2, Math.min(60, Math.floor(value))) : 5;
}

async function processorState(response: Response, processorUrl: string, currentStatusUrl?: string): Promise<ProcessorState> {
  const text = await readBoundedText(response);
  let body: { status?: unknown; statusUrl?: unknown; retryAfterSeconds?: unknown; result?: unknown; error?: unknown };
  try { body = JSON.parse(text) as typeof body; }
  catch { throw new Error(`Processor returned invalid JSON (HTTP ${response.status}).`); }

  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `Processor returned HTTP ${response.status}.`;
    throw new Error(message.slice(0, 500));
  }

  if (body.status === "done") return { status: "done", resultJson: JSON.stringify(body.result ?? null) };
  if (body.status === "failed") {
    const message = typeof body.error === "string" ? body.error : "Product processor reported a failed job.";
    return { status: "failed", error: message.slice(0, 500) };
  }
  if (body.status === "queued" || body.status === "running") {
    const statusUrl = body.statusUrl === undefined && currentStatusUrl
      ? currentStatusUrl
      : processorStatusUrl(body.statusUrl, processorUrl);
    return { status: body.status, statusUrl, retryAfterSeconds: retryDelay(body.retryAfterSeconds) };
  }

  // Keep existing synchronous processors compatible with the async protocol.
  if (response.status === 200 && Object.hasOwn(body, "result")) return { status: "done", resultJson: JSON.stringify(body.result ?? null) };
  throw new Error("Processor returned an unsupported job status.");
}

export class JobWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep): Promise<void> {
    const jobId = event.payload.jobId;
    const job = await step.do("load job", async () => {
      const row = await this.env.DB.prepare("SELECT * FROM jobs WHERE id = ?")
        .bind(jobId).first<JobRow>();
      if (!row) throw new Error("Queue job was not found.");
      if (row.status === "cancelled") return null;
      return row;
    });
    if (!job) return;

    let pauseCheck = 0;
    while (true) {
      const state = await step.do(`check queue state ${pauseCheck}`, async () => {
        const [setting, latestJob] = await Promise.all([
          this.env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first<{ value: string }>(),
          this.env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(jobId).first<{ status: string }>(),
        ]);
        return { paused: setting?.value === "true", cancelled: latestJob?.status === "cancelled" };
      });
      if (state.cancelled) return;
      if (!state.paused) break;
      await step.sleep(`wait while paused ${pauseCheck}`, "10 seconds");
      pauseCheck += 1;
    }

    const runningAt = new Date().toISOString();
    const canStart = await step.do("mark running", async () => {
      const changed = await this.env.DB.prepare(
        "UPDATE jobs SET status='running', attempts=attempts+1, started_at=?, error=NULL WHERE id=? AND status='queued'",
      ).bind(runningAt, jobId).run();
      if (!changed.meta.changes) return false;
      await this.env.DB.prepare(
        "INSERT INTO activity(job_id, project, kind, message, created_at) VALUES (?, ?, 'started', ?, ?)",
      ).bind(jobId, job.project, `${job.name} started in ${job.project}`, runningAt).run();
      return true;
    });
    if (!canStart) return;

    try {
      const processor = {
        cutrank: { url: this.env.CUTRANK_PROCESSOR_URL, token: this.env.CUTRANK_PROCESSOR_TOKEN },
        listvint: { url: this.env.LISTVINT_PROCESSOR_URL, token: this.env.LISTVINT_PROCESSOR_TOKEN },
        modhorizon: { url: this.env.MODHORIZON_PROCESSOR_URL, token: this.env.MODHORIZON_PROCESSOR_TOKEN },
      }[job.project as ProjectId];
      const { url, token } = processor;
      if (!url || !token) throw new Error(`The ${job.project} processor is not configured.`);

      let processorResult: ProcessorState = await step.do<ProcessorState>(
        "submit project job to processor",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            redirect: "manual",
            body: JSON.stringify({
              id: job.id,
              project: job.project,
              type: job.type,
              name: job.name,
              submittedBy: job.submitted_by,
              payload: JSON.parse(job.payload_json),
              attempt: job.attempts + 1,
            }),
          });
          if (response.status >= 300 && response.status < 400) throw new Error("Processor redirects are not allowed.");
          return processorState(response, url);
        },
      );

      let poll = 0;
      while (processorResult.status === "queued" || processorResult.status === "running") {
        if (poll >= MAX_PROCESSOR_POLLS) throw new Error("Product processor did not finish before the queue polling limit.");
        await step.sleep(`wait for processor ${poll}`, `${processorResult.retryAfterSeconds} seconds`);
        const statusUrl = processorResult.statusUrl;
        processorResult = await step.do<ProcessorState>(
          `poll processor ${poll}`,
          { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
          async () => {
            const response = await fetch(statusUrl, {
              method: "GET",
              headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
              redirect: "manual",
            });
            if (response.status >= 300 && response.status < 400) throw new Error("Processor status redirects are not allowed.");
            return processorState(response, url, statusUrl);
          },
        );
        poll += 1;
      }
      if (processorResult.status === "failed") throw new Error(processorResult.error);
      if (processorResult.status !== "done") throw new Error("Processor polling ended before a terminal result was returned.");

      const completedAt = new Date().toISOString();
      await step.do("save completed result", async () => {
        await this.env.DB.prepare(
          "UPDATE jobs SET status='done', result_json=?, error=NULL, completed_at=? WHERE id=?",
        ).bind(processorResult.resultJson, completedAt, jobId).run();
        await this.env.DB.prepare(
          "INSERT INTO activity(job_id, project, kind, message, created_at) VALUES (?, ?, 'completed', ?, ?)",
        ).bind(jobId, job.project, `${job.name} completed successfully`, completedAt).run();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job processing failed.";
      const completedAt = new Date().toISOString();
      await step.do("save failed result", async () => {
        await this.env.DB.prepare(
          "UPDATE jobs SET status='failed', error=?, completed_at=? WHERE id=?",
        ).bind(message.slice(0, 1000), completedAt, jobId).run();
        await this.env.DB.prepare(
          "INSERT INTO activity(job_id, project, kind, message, created_at) VALUES (?, ?, 'failed', ?, ?)",
        ).bind(jobId, job.project, `${job.name} failed: ${message.slice(0, 180)}`, completedAt).run();
      });
      throw error;
    }
  }
}
