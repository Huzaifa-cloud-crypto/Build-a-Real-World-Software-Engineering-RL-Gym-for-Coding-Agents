import * as fs from 'fs';
import * as path from 'path';
import { runCli, resetStoreDir, readStateJson } from '../helpers';

export function test_worker_executes_payload(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_02_a');
  resetStoreDir(storeDir);
  const now = '2026-09-16T12:00:00.000Z';

  const stateFilePath = path.join(storeDir, 'state.json');
  const checkCode = "const fs=require('fs');const st=JSON.parse(fs.readFileSync(process.argv[1],'utf-8'));const j=Object.values(st.jobs)[0];if(j.state!=='processing'||!j.lock_expires_at)process.exit(1);const lt=new Date(j.lock_expires_at).getTime();const mt=new Date('2026-09-16T12:00:00.000Z').getTime()+10000;if(lt<mt)process.exit(2);console.log('EXEC_OK');";

  const payload = JSON.stringify({ cmd: 'node', args: ['-e', checkCode, stateFilePath] });
  const enqRes = runCli(cliPath, ['enqueue', '--name', 'exec_job', '--payload', payload], storeDir, now);
  if (enqRes.code !== 0) return false;
  const jobId = enqRes.stdout.trim();

  const runRes = runCli(cliPath, ['worker', 'run-once', '--worker-id', 'w1'], storeDir, now);
  if (runRes.code !== 0) return false;

  const state = readStateJson(storeDir);
  if (!state || !state.jobs || !state.jobs[jobId]) return false;

  const job = state.jobs[jobId];
  return job.state === 'completed';
}

export function test_worker_writes_logs(cliPath: string, testDir: string): boolean {
  const storeDir = path.join(testDir, 'store_02_b');
  resetStoreDir(storeDir);
  const now = '2026-09-16T12:00:00.000Z';

  const payload = JSON.stringify({ cmd: 'node', args: ['-e', 'console.log("UNIQUE_LOG_MARKER")'] });
  const enqRes = runCli(cliPath, ['enqueue', '--name', 'log_job', '--payload', payload], storeDir, now);
  const jobId = enqRes.stdout.trim();

  runCli(cliPath, ['worker', 'run-once', '--worker-id', 'w1'], storeDir, now);

  const logFile = path.join(storeDir, 'logs', `${jobId}.log`);
  if (!fs.existsSync(logFile)) return false;

  const logContent = fs.readFileSync(logFile, 'utf-8');
  return logContent.includes('Attempt 1') && logContent.includes('UNIQUE_LOG_MARKER');
}
