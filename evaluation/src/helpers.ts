import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(cliPath: string, args: string[], storeDir: string, now?: string): CliResult {
  const storeArgs = ['--store-dir', storeDir];
  const nowArgs = now ? ['--now', now] : [];
  const fullArgs = [...args, ...storeArgs, ...nowArgs];

  const env = { ...process.env };
  if (now) {
    env.SCHEDULER_FAKE_NOW = now;
  }

  const res = spawnSync('node', [cliPath, ...fullArgs], {
    encoding: 'utf-8',
    env
  });

  return {
    code: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || ''
  };
}

export function resetStoreDir(storeDir: string): void {
  if (fs.existsSync(storeDir)) {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
  fs.mkdirSync(storeDir, { recursive: true });
}

export function readStateJson(storeDir: string): any {
  const stateFile = path.join(storeDir, 'state.json');
  if (!fs.existsSync(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}
