import * as path from 'path';
import { runCli, resetStoreDir, readStateJson } from '../helpers';

export function test_sigkill_visibility_timeout_reclaim(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_05_a');
  resetStoreDir(storeDir);
  const t0 = new Date('2026-09-16T12:00:00.000Z');

  // Enqueue hanging job (long sleep)
  const payload = JSON.stringify({ cmd: 'node', args: ['-e', 'setTimeout(()=>{}, 60000)'] });
  const enqRes = runCli(cliPath, ['enqueue', '--name', 'hanging_job', '--payload', payload, '--max-retries', '3'], storeDir, t0.toISOString());
  const jobId = enqRes.stdout.trim();

  // Worker 1 claims job at t0 with visibility-timeout 2000ms
  // In black-box test, we manually set state to processing claimed_by worker_1 with lock_expires_at = t0 + 2000ms to simulate a SIGKILL'd worker process mid-execution.
  const state = readStateJson(storeDir);
  state.jobs[jobId].state = 'processing';
  state.jobs[jobId].claimed_by = 'worker_killed';
  state.jobs[jobId].lock_expires_at = new Date(t0.getTime() + 2000).toISOString();
  state.jobs[jobId].last_heartbeat_at = t0.toISOString();
  
  // Save manually updated state representing SIGKILL crash
  const fs = require('fs');
  fs.writeFileSync(path.join(storeDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');

  // At t0 + 1000ms (lock not yet expired), worker 2 run-once should NOT reclaim
  const t1 = new Date(t0.getTime() + 1000).toISOString();
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'worker_2'], storeDir, t1);
  const stateMid = readStateJson(storeDir);
  if (stateMid.jobs[jobId].claimed_by !== 'worker_killed') return false;

  // At t0 + 3000ms (lock expired), worker 2 run-once SHOULD detect expired lock and reclaim job
  const t2 = new Date(t0.getTime() + 3000).toISOString();
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'worker_2'], storeDir, t2);

  const stateEnd = readStateJson(storeDir);
  const job = stateEnd.jobs[jobId];
  return job && job.attempts >= 1 && (job.state === 'pending' || job.state === 'completed' || job.state === 'processing');
}
