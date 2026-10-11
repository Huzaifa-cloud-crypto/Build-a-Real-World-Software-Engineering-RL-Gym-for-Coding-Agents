import * as path from 'path';
import { runCli, resetStoreDir, readStateJson } from '../helpers';

export function test_exponential_backoff_calculation(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_04_a');
  resetStoreDir(storeDir);
  const t0 = new Date('2026-09-16T12:00:00.000Z');

  const payload = JSON.stringify({ cmd: 'node', args: ['-e', 'process.exit(1)'] });
  const enqRes = runCli(cliPath, ['enqueue', '--name', 'backoff_job', '--payload', payload, '--max-retries', '3'], storeDir, t0.toISOString());
  const jobId = enqRes.stdout.trim();

  // Attempt 1 failure at t0 -> delay = 1000 * 2^(1-1) = 1000ms -> run_at = t0 + 1000ms
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'w1'], storeDir, t0.toISOString());

  const state1 = readStateJson(storeDir);
  const job1 = state1.jobs[jobId];
  if (!job1 || job1.state !== 'pending' || job1.attempts !== 1) return false;

  const expectedRunAt1 = new Date(t0.getTime() + 1000).toISOString();
  if (job1.run_at !== expectedRunAt1) return false;

  // Attempt 2 failure at t0 + 1000ms -> delay = 1000 * 2^(2-1) = 2000ms -> run_at = (t0 + 1000ms) + 2000ms = t0 + 3000ms
  const t1 = new Date(t0.getTime() + 1000).toISOString();
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'w1'], storeDir, t1);

  const state2 = readStateJson(storeDir);
  const job2 = state2.jobs[jobId];
  if (!job2 || job2.state !== 'pending' || job2.attempts !== 2) return false;

  const expectedRunAt2 = new Date(t0.getTime() + 3000).toISOString();
  return job2.run_at === expectedRunAt2;
}

export function test_max_retries_dead_letter_transition(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_04_b');
  resetStoreDir(storeDir);
  const t0 = new Date('2026-09-16T12:00:00.000Z');

  const payload = JSON.stringify({ cmd: 'node', args: ['-e', 'process.exit(1)'] });
  const enqRes = runCli(cliPath, ['enqueue', '--name', 'dlq_job', '--payload', payload, '--max-retries', '2'], storeDir, t0.toISOString());
  const jobId = enqRes.stdout.trim();

  // Attempt 1 at t0
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'w1'], storeDir, t0.toISOString());
  // Attempt 2 at t0 + 1000ms (max_retries = 2 reached)
  const t1 = new Date(t0.getTime() + 1000).toISOString();
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'w1'], storeDir, t1);

  const state = readStateJson(storeDir);
  const job = state.jobs[jobId];
  return job && job.state === 'dead_letter' && job.attempts === 2;
}

export function test_admin_retry_command(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_04_c');
  resetStoreDir(storeDir);
  const t0 = new Date('2026-09-16T12:00:00.000Z');

  const payload = JSON.stringify({ cmd: 'node', args: ['-e', 'process.exit(1)'] });
  const enqRes = runCli(cliPath, ['enqueue', '--name', 'retry_admin_job', '--payload', payload, '--max-retries', '1'], storeDir, t0.toISOString());
  const jobId = enqRes.stdout.trim();

  // Fail job into DLQ
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'w1'], storeDir, t0.toISOString());

  const state1 = readStateJson(storeDir);
  if (state1.jobs[jobId].state !== 'dead_letter') return false;

  // Execute admin retry
  const t2 = new Date('2026-09-16T13:00:00.000Z').toISOString();
  const retryRes = runCli(cliPath, ['retry', '--job-id', jobId], storeDir, t2);
  if (retryRes.code !== 0) return false;

  const state2 = readStateJson(storeDir);
  const job = state2.jobs[jobId];
  return job && job.state === 'pending' && job.attempts === 0 && job.run_at === t2;
}
