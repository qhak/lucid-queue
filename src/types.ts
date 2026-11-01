export type ProjectId = "cutrank" | "listvint" | "modhorizon";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobRow {
  id: string;
  project: ProjectId;
  name: string;
  type: string;
  status: JobStatus;
  submitted_by: string | null;
  idempotency_key: string | null;
  payload_json: string;
  result_json: string | null;
  error: string | null;
  workflow_id: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface JobParams {
  jobId: string;
}

export interface Env {
  DB: D1Database;
  JOB_RUNNER: Workflow<JobParams>;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  LUCID_ADMIN_PASSWORD: string;
  LUCID_SESSION_SECRET: string;
  LUCID_CUTRANK_TOKEN: string;
  LUCID_LISTVINT_TOKEN: string;
  LUCID_MODHORIZON_TOKEN: string;
  CUTRANK_PROCESSOR_URL: string;
  LISTVINT_PROCESSOR_URL: string;
  MODHORIZON_PROCESSOR_URL: string;
  CUTRANK_PROCESSOR_TOKEN: string;
  LISTVINT_PROCESSOR_TOKEN: string;
  MODHORIZON_PROCESSOR_TOKEN: string;
}
