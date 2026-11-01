import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, JobParams, JobRow, ProjectId } from "./types";

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
      const result = await step.do(
        "process project job",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const processor = {
            cutrank: { url: this.env.CUTRANK_PROCESSOR_URL, token: this.env.CUTRANK_PROCESSOR_TOKEN },
            listvint: { url: this.env.LISTVINT_PROCESSOR_URL, token: this.env.LISTVINT_PROCESSOR_TOKEN },
            modhorizon: { url: this.env.MODHORIZON_PROCESSOR_URL, token: this.env.MODHORIZON_PROCESSOR_TOKEN },
          }[job.project as ProjectId];
          const { url, token } = processor;
          if (!url || !token) throw new Error(`The ${job.project} processor is not configured.`);

          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
          const text = await response.text();
          if (text.length > 1_000_000) throw new Error("Processor response exceeds the 1 MB result limit; return a storage reference instead.");
          let body: { result?: unknown; error?: string };
          try { body = JSON.parse(text) as { result?: unknown; error?: string }; }
          catch { throw new Error(`Processor returned invalid JSON (HTTP ${response.status}).`); }
          if (!response.ok) throw new Error(body.error || `Processor returned HTTP ${response.status}.`);
          return body.result ?? null;
        },
      );

      const completedAt = new Date().toISOString();
      await step.do("save completed result", async () => {
        await this.env.DB.prepare(
          "UPDATE jobs SET status='done', result_json=?, error=NULL, completed_at=? WHERE id=?",
        ).bind(JSON.stringify(result), completedAt, jobId).run();
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
