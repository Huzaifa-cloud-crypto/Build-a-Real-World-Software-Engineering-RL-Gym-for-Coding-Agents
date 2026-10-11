import { execFile } from 'child_process';
import { Storage, getReferenceTime } from './storage';
import { Job, QueueState } from './types';

export interface WorkerRunOnceOptions {
  workerId: string;
  visibilityTimeoutMs?: number;
  storeDir?: string;
  now?: string;
}

export function runWorkerOnce(options: WorkerRunOnceOptions): { processed: boolean; jobId?: string; error?: boolean } {
  const storage = new Storage(options.storeDir);
  const now = getReferenceTime(options.now);
  const visibilityTimeout = options.visibilityTimeoutMs || 30000;
  const state = storage.loadState();

  const nowIso = now.toISOString();

  // 1. First reclaim any orphaned processing jobs with expired locks
  for (const job of Object.values(state.jobs)) {
    if (job.state === 'processing' && job.lock_expires_at) {
      const lockExpiry = new Date(job.lock_expires_at).getTime();
      if (now.getTime() > lockExpiry) {
        // Lock expired - reclaim
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

  // 2. Find eligible job to claim
  let targetJob: Job | null = null;
  for (const job of Object.values(state.jobs)) {
    if (job.state === 'pending') {
      if (!job.run_at || new Date(job.run_at).getTime() <= now.getTime()) {
        targetJob = job;
        break;
      }
    }
  }

  if (!targetJob) {
    storage.saveState(state);
    return { processed: false };
  }

  // Claim job atomically
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

  // 3. Execute payload
  const payload = targetJob.payload || { cmd: 'echo', args: [] };
  const cmd = payload.cmd || 'echo';
  const args = payload.args || [];

  const attemptIndex = targetJob.attempts + 1;
  const execStartTime = getReferenceTime(options.now);

  return new Promise<{ processed: boolean; jobId?: string; error?: boolean }>((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      const execEndTime = getReferenceTime(options.now);
      const endIso = execEndTime.toISOString();
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();

      // Reload fresh state in case of concurrent modifications
      const latestState = storage.loadState();
      const freshJob = latestState.jobs[targetJob!.id];

      if (!freshJob) {
        resolve({ processed: true, jobId: targetJob!.id, error: true });
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
    });
  }) as any;
}

export async function startWorkerDaemon(options: {
  workerId: string;
  visibilityTimeoutMs?: number;
  pollIntervalMs?: number;
  queues?: string[];
  storeDir?: string;
}): Promise<void> {
  const pollInterval = options.pollIntervalMs || 1000;
  let running = true;

  const shutdown = () => {
    running = false;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (running) {
    try {
      await runWorkerOnce({
        workerId: options.workerId,
        visibilityTimeoutMs: options.visibilityTimeoutMs,
        storeDir: options.storeDir
      });
    } catch {
      // Continue worker loop on error
    }
    await new Promise((res) => setTimeout(res, pollInterval));
  }
}
