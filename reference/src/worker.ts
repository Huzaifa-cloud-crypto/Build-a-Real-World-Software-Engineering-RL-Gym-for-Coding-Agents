import { execFile } from 'child_process';
import { Storage, getReferenceTime } from './storage';
import { Job, JobPayload } from './types';

export interface WorkerRunOnceOptions {
  workerId: string;
  visibilityTimeoutMs?: number;
  storeDir?: string;
  now?: string;
  queues?: string[];
}

export interface WorkerRunOnceResult {
  processed: boolean;
  jobId?: string;
  error?: boolean;
  contended?: boolean;
}

const DEFAULT_VISIBILITY_TIMEOUT = 30000;

export async function runWorkerOnce(options: WorkerRunOnceOptions): Promise<WorkerRunOnceResult> {
  const storage = new Storage(options.storeDir);
  const now = getReferenceTime(options.now);
  const visibilityTimeout = options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT;
  const queues = options.queues && options.queues.length ? options.queues : null;
  const nowIso = now.toISOString();

  // Claim under a store-wide mutex so two workers cannot both take the same
  // job. The lock covers the read-modify-write only, never job execution.
  if (!storage.acquireLock('state')) {
    return { processed: false, contended: true };
  }

  let claimedId: string | null = null;
  let claimedPayload: JobPayload = { cmd: 'echo', args: [] };
  let claimedAttempts = 0;

  try {
    const state = storage.loadState();

    // 1. Reclaim orphaned processing jobs whose visibility lock has expired.
    for (const job of Object.values(state.jobs)) {
      if (job.state === 'processing' && job.lock_expires_at) {
        const lockExpiry = new Date(job.lock_expires_at).getTime();
        if (now.getTime() > lockExpiry) {
          job.attempts += 1;
          job.claimed_by = null;
          job.lock_expires_at = null;
          job.last_heartbeat_at = null;
          job.updated_at = nowIso;

          if (job.attempts >= job.max_retries) {
            job.state = 'dead_letter';
            storage.appendLog(job.id, now, job.attempts, `Visibility timeout expired. Max retries exceeded (${job.max_retries}). Moved to dead_letter.`);
          } else {
            job.state = 'pending';
            const backoffDelay = 1000 * Math.pow(2, job.attempts - 1);
            job.run_at = new Date(now.getTime() + backoffDelay).toISOString();
            storage.appendLog(job.id, now, job.attempts, `Visibility timeout expired. Reclaimed job. Set run_at to ${job.run_at}.`);
          }
        }
      }
    }

    // 2. Find the first eligible pending job.
    let targetJob: Job | null = null;
    for (const job of Object.values(state.jobs)) {
      if (job.state !== 'pending') continue;
      if (queues && !queues.includes(job.queue)) continue;
      if (!job.run_at || new Date(job.run_at).getTime() <= now.getTime()) {
        targetJob = job;
        break;
      }
    }

    if (!targetJob) {
      storage.saveState(state);
      return { processed: false };
    }

    targetJob.state = 'processing';
    targetJob.claimed_by = options.workerId;
    targetJob.lock_expires_at = new Date(now.getTime() + visibilityTimeout).toISOString();
    targetJob.last_heartbeat_at = nowIso;
    targetJob.updated_at = nowIso;
    state.workers[options.workerId] = {
      id: options.workerId,
      last_heartbeat_at: nowIso
    };

    storage.saveState(state);

    claimedId = targetJob.id;
    claimedPayload = targetJob.payload || { cmd: 'echo', args: [] };
    claimedAttempts = targetJob.attempts;
  } finally {
    storage.releaseLock('state');
  }

  if (!claimedId) {
    return { processed: false };
  }

  // 3. Execute the payload outside the lock; heartbeats keep the lock alive.
  const stopHeartbeat = startHeartbeat(storage, options.workerId, claimedId, visibilityTimeout);

  try {
    return await executeJob(storage, claimedId, claimedPayload, claimedAttempts, options);
  } finally {
    stopHeartbeat();
  }
}

function startHeartbeat(
  storage: Storage,
  workerId: string,
  jobId: string,
  visibilityTimeout: number
): () => void {
  const interval = setInterval(() => {
    if (!storage.acquireLock('state', 5000)) return;
    try {
      const state = storage.loadState();
      const job = state.jobs[jobId];
      if (!job || job.state !== 'processing' || job.claimed_by !== workerId) return;
      const stamp = new Date();
      job.last_heartbeat_at = stamp.toISOString();
      job.lock_expires_at = new Date(stamp.getTime() + visibilityTimeout).toISOString();
      state.workers[workerId] = { id: workerId, last_heartbeat_at: job.last_heartbeat_at };
      storage.saveState(state);
    } finally {
      storage.releaseLock('state');
    }
  }, Math.max(1000, Math.floor(visibilityTimeout / 2)));

  interval.unref();
  return () => clearInterval(interval);
}

function executeJob(
  storage: Storage,
  jobId: string,
  payload: JobPayload,
  attemptsAtClaim: number,
  options: WorkerRunOnceOptions
): Promise<WorkerRunOnceResult> {
  const cmd = payload.cmd || 'echo';
  const args = payload.args || [];
  const attemptIndex = attemptsAtClaim + 1;

  return new Promise<WorkerRunOnceResult>((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      const execEndTime = getReferenceTime(options.now);
      const endIso = execEndTime.toISOString();
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();

      // Re-acquire the mutex and reload so concurrent workers' writes survive.
      if (!storage.acquireLock('state')) {
        resolve({ processed: true, jobId, error: true });
        return;
      }

      try {
        const latestState = storage.loadState();
        const freshJob = latestState.jobs[jobId];

        if (!freshJob) {
          resolve({ processed: true, jobId, error: true });
          return;
        }

        if (err) {
          freshJob.attempts += 1;
          freshJob.claimed_by = null;
          freshJob.lock_expires_at = null;
          freshJob.last_heartbeat_at = null;
          freshJob.updated_at = endIso;

          storage.appendLog(freshJob.id, execEndTime, freshJob.attempts, `Execution failed with exit code ${err.code || 1}.\nOutput: ${output}\nError: ${err.message}`);

          if (freshJob.attempts >= freshJob.max_retries) {
            freshJob.state = 'dead_letter';
            storage.appendLog(freshJob.id, execEndTime, freshJob.attempts, `Max retries (${freshJob.max_retries}) reached. Moved to dead_letter.`);
          } else {
            freshJob.state = 'pending';
            const backoffDelay = 1000 * Math.pow(2, freshJob.attempts - 1);
            freshJob.run_at = new Date(execEndTime.getTime() + backoffDelay).toISOString();
          }

          storage.saveState(latestState);
          resolve({ processed: true, jobId: freshJob.id, error: true });
        } else {
          freshJob.state = 'completed';
          freshJob.claimed_by = null;
          freshJob.lock_expires_at = null;
          freshJob.last_heartbeat_at = null;
          freshJob.updated_at = endIso;

          storage.appendLog(freshJob.id, execEndTime, attemptIndex, `Execution succeeded.\nOutput: ${output}`);
          storage.saveState(latestState);
          resolve({ processed: true, jobId: freshJob.id, error: false });
        }
      } finally {
        storage.releaseLock('state');
      }
    });
  });
}

export async function startWorkerDaemon(options: {
  workerId: string;
  visibilityTimeoutMs?: number;
  pollIntervalMs?: number;
  queues?: string[];
  storeDir?: string;
}): Promise<void> {
  const pollInterval = options.pollIntervalMs ?? 1000;
  const visibilityTimeout = options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT;
  let running = true;

  const shutdown = () => {
    running = false;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Awaited inline, so a signal only takes effect once the active job has
  // finished and its final state has been written.
  while (running) {
    try {
      await runWorkerOnce({
        workerId: options.workerId,
        visibilityTimeoutMs: visibilityTimeout,
        storeDir: options.storeDir,
        queues: options.queues
      });
    } catch {
      // Keep polling; a single failed claim must not kill the daemon.
    }
    if (!running) break;
    await new Promise((res) => setTimeout(res, pollInterval));
  }
}
