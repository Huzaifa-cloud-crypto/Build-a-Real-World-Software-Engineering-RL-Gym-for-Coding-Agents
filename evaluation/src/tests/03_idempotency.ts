import * as path from 'path';
import { runCli, resetStoreDir, readStateJson } from '../helpers';

export function test_idempotency_key_deduplication(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_03_a');
  resetStoreDir(storeDir);

  const res1 = runCli(cliPath, ['enqueue', '--name', 'job_idem', '--idempotency-key', 'key_abc'], storeDir);
  if (res1.code !== 0) return false;
  const jobId1 = res1.stdout.trim();

  const res2 = runCli(cliPath, ['enqueue', '--name', 'job_idem', '--idempotency-key', 'key_abc'], storeDir);
  if (res2.code !== 0) return false;
  const jobId2 = res2.stdout.trim();

  if (jobId1 !== jobId2) return false;

  const state = readStateJson(storeDir);
  return Object.keys(state.jobs).length === 1;
}

export function test_dead_letter_idempotency_force(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_03_b');
  resetStoreDir(storeDir);
  const now = '2026-09-16T12:00:00.000Z';

  // Enqueue job with max-retries 1 and failing command
  const payload = JSON.stringify({ cmd: 'node', args: ['-e', 'process.exit(1)'] });
  const enqRes = runCli(cliPath, ['enqueue', '--name', 'dlq_idem_job', '--payload', payload, '--max-retries', '1', '--idempotency-key', 'dlq_key'], storeDir, now);
  if (enqRes.code !== 0) return false;

  // Run worker to fail job and move it to dead_letter
  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'w1'], storeDir, now);

  const state1 = readStateJson(storeDir);
  const job1 = Object.values(state1.jobs).find((j: any) => j.idempotency_key === 'dlq_key') as any;
  if (!job1 || job1.state !== 'dead_letter') return false;

  // Attempt enqueue with same key without --force should fail (code != 0)
  const noForceRes = runCli(cliPath, ['enqueue', '--name', 'dlq_idem_job', '--idempotency-key', 'dlq_key'], storeDir, now);
  if (noForceRes.code === 0) return false;

  // Attempt enqueue with --force should succeed (code === 0)
  const forceRes = runCli(cliPath, ['enqueue', '--name', 'dlq_idem_job', '--idempotency-key', 'dlq_key', '--force'], storeDir, now);
  return forceRes.code === 0;
}
