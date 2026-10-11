import * as fs from 'fs';
import * as path from 'path';
import { runCli, resetStoreDir, readStateJson } from '../helpers';

export function test_enqueue_creates_pending_job(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_01_a');
  resetStoreDir(storeDir);
  const now = '2026-09-16T12:00:00.000Z';

  const res = runCli(cliPath, ['enqueue', '--name', 'test_job', '--payload', JSON.stringify({ cmd: 'echo', args: ['hi'] })], storeDir, now);
  if (res.code !== 0) return false;

  const jobId = res.stdout.trim();
  if (!jobId || !jobId.startsWith('job_')) return false;

  const state = readStateJson(storeDir);
  if (!state || !state.jobs || !state.jobs[jobId]) return false;

  const job = state.jobs[jobId];
  if (job.name !== 'test_job') return false;
  if (job.state !== 'pending') return false;
  if (job.attempts !== 0) return false;
  if (job.queue !== 'default') return false;
  if (job.max_retries !== 3) return false;
  if (job.created_at !== now) return false;

  // Verify atomic persistence: no leftover temporary state files
  const storeFiles = fs.readdirSync(storeDir);
  const leftoverTmpFiles = storeFiles.filter(f => f.startsWith('state.json.tmp.'));
  if (leftoverTmpFiles.length > 0) return false;

  // Verify scheduled job with --delay
  const delayedRes = runCli(cliPath, ['enqueue', '--name', 'delayed_job', '--delay', '5000'], storeDir, now);
  if (delayedRes.code !== 0) return false;
  const delayedJobId = delayedRes.stdout.trim();
  const stateAfterDelay = readStateJson(storeDir);
  if (!stateAfterDelay || !stateAfterDelay.jobs || !stateAfterDelay.jobs[delayedJobId]) return false;
  const delayedJob = stateAfterDelay.jobs[delayedJobId];
  const expectedRunAt = new Date(new Date(now).getTime() + 5000).toISOString();
  if (delayedJob.run_at !== expectedRunAt) return false;

  // Verify atomic persistence after delayed enqueue
  const storeFilesAfter = fs.readdirSync(storeDir);
  if (storeFilesAfter.some(f => f.startsWith('state.json.tmp.'))) return false;

  return true;
}

export function test_inspect_returns_counts(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_01_b');
  resetStoreDir(storeDir);

  runCli(cliPath, ['enqueue', '--name', 'job1'], storeDir);
  runCli(cliPath, ['enqueue', '--name', 'job2'], storeDir);

  const res = runCli(cliPath, ['inspect'], storeDir);
  if (res.code !== 0) return false;

  try {
    const counts = JSON.parse(res.stdout.trim());
    if (counts.pending !== 2) return false;
    if (counts.processing !== 0) return false;
    if (counts.completed !== 0) return false;
    if (counts.failed !== 0) return false;
    if (counts.dead_letter !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

export function test_state_dump_file(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_01_c');
  resetStoreDir(storeDir);
  const dumpFile = path.join(testDir, 'dump_output.json');

  runCli(cliPath, ['enqueue', '--name', 'dump_test_job'], storeDir);
  const res = runCli(cliPath, ['state', 'dump', '--file', dumpFile], storeDir);
  if (res.code !== 0) return false;

  if (!fs.existsSync(dumpFile)) return false;
  const dumpedData = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  const realState = readStateJson(storeDir);

  return JSON.stringify(dumpedData) === JSON.stringify(realState);
}
