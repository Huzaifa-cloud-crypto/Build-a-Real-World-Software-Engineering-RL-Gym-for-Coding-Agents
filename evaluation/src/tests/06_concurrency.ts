import * as path from 'path';
import { runCli, resetStoreDir, readStateJson } from '../helpers';

export function test_deterministic_lock_contention(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_06_a');
  resetStoreDir(storeDir);
  const t0 = new Date('2026-09-16T12:00:00.000Z');

  const enqRes = runCli(cliPath, ['enqueue', '--name', 'concurrent_job'], storeDir, t0.toISOString());
  const jobId = enqRes.stdout.trim();

  // Simulate Worker A claiming job J with active unexpired lock
  const state = readStateJson(storeDir);
  state.jobs[jobId].state = 'processing';
  state.jobs[jobId].claimed_by = 'worker_A';
  state.jobs[jobId].lock_expires_at = new Date(t0.getTime() + 60000).toISOString();
  state.jobs[jobId].last_heartbeat_at = t0.toISOString();

  const fs = require('fs');
  fs.writeFileSync(path.join(storeDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');

  // Worker B runs run-once at t0 + 5000ms (lock active until t0 + 60000ms)
  const t1 = new Date(t0.getTime() + 5000).toISOString();
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'worker_B'], storeDir, t1);

  // Worker B must NOT have claimed or modified worker_A's claim on job J
  const stateAfter = readStateJson(storeDir);
  const job = stateAfter.jobs[jobId];

  return job && job.state === 'processing' && job.claimed_by === 'worker_A';
}
