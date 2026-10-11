export type JobState = "pending" | "processing" | "completed" | "failed" | "dead_letter";

export interface JobPayload {
  cmd: string;
  args?: string[];
}

export interface Job {
  id: string;
  name: string;
  queue: string;
  payload: JobPayload;
  state: JobState;
  attempts: number;
  max_retries: number;
  claimed_by: string | null;
  lock_expires_at: string | null;
  last_heartbeat_at: string | null;
  idempotency_key: string | null;
  run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerInfo {
  id: string;
  last_heartbeat_at: string;
}

export interface QueueState {
  jobs: Record<string, Job>;
  workers: Record<string, WorkerInfo>;
}
