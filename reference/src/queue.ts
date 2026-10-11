import * as fs from 'fs';
import { Storage, getReferenceTime } from './storage';
import { Job, JobPayload, QueueState } from './types';

export interface EnqueueOptions {
  name: string;
  payload?: JobPayload;
  queue?: string;
  delayMs?: number;
  maxRetries?: number;
  idempotencyKey?: string;
  force?: boolean;
  storeDir?: string;
  now?: string;
}

export function enqueueJob(options: EnqueueOptions): { jobId: string; existing: boolean } {
  const storage = new Storage(options.storeDir);
  const now = getReferenceTime(options.now);
  const state = storage.loadState();

  const queue = options.queue || 'default';
  const maxRetries = options.maxRetries !== undefined ? Number(options.maxRetries) : 3;
  const idempotencyKey = options.idempotencyKey || null;
  const payload = options.payload || { cmd: 'echo', args: [] };

  if (idempotencyKey) {
    const existingJob = Object.values(state.jobs).find(j => j.idempotency_key === idempotencyKey);
    if (existingJob) {
      if (existingJob.state === 'dead_letter' && !options.force) {
        throw new Error(`Job with idempotency key '${idempotencyKey}' is in dead_letter state. Use --force to re-enqueue.`);
      }
      if (['pending', 'processing', 'completed'].includes(existingJob.state)) {
        return { jobId: existingJob.id, existing: true };
      }
    }
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const delayMs = options.delayMs ? Number(options.delayMs) : 0;
  const runAt = new Date(now.getTime() + delayMs).toISOString();
  const nowIso = now.toISOString();

  const newJob: Job = {
    id: jobId,
    name: options.name,
    queue,
    payload,
    state: 'pending',
    attempts: 0,
    max_retries: maxRetries,
    claimed_by: null,
    lock_expires_at: null,
    last_heartbeat_at: null,
    idempotency_key: idempotencyKey,
    run_at: runAt,
    created_at: nowIso,
    updated_at: nowIso
  };

  state.jobs[jobId] = newJob;
  storage.saveState(state);
  return { jobId, existing: false };
}

export function retryJob(jobId: string, storeDir?: string, nowArg?: string): Job {
  const storage = new Storage(storeDir);
  const now = getReferenceTime(nowArg);
  const state = storage.loadState();

  const job = state.jobs[jobId];
  if (!job) {
    throw new Error(`Job '${jobId}' not found.`);
  }

  if (job.state !== 'failed' && job.state !== 'dead_letter') {
    throw new Error(`Job '${jobId}' is in state '${job.state}', cannot retry.`);
  }

  const nowIso = now.toISOString();
  job.state = 'pending';
  job.attempts = 0;
  job.claimed_by = null;
  job.lock_expires_at = null;
  job.last_heartbeat_at = null;
  job.run_at = nowIso;
  job.updated_at = nowIso;

  storage.saveState(state);
  return job;
}

export function inspectState(queueFilter?: string, storeDir?: string, nowArg?: string): Record<string, number> {
  const storage = new Storage(storeDir);
  const state = storage.loadState();

  const counts = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    dead_letter: 0
  };

  for (const job of Object.values(state.jobs)) {
    if (queueFilter && job.queue !== queueFilter) continue;
    if (counts.hasOwnProperty(job.state)) {
      counts[job.state as keyof typeof counts]++;
    }
  }

  return counts;
}

export function dumpState(file: string, storeDir?: string): void {
  const storage = new Storage(storeDir);
  const state = storage.loadState();
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
}

export function purgeJobs(queueFilter?: string, stateFilter?: string, storeDir?: string): number {
  const storage = new Storage(storeDir);
  const state = storage.loadState();
  let count = 0;

  for (const [id, job] of Object.entries(state.jobs)) {
    if (queueFilter && job.queue !== queueFilter) continue;
    if (stateFilter && job.state !== stateFilter) continue;
    delete state.jobs[id];
    count++;
  }

  storage.saveState(state);
  return count;
}
