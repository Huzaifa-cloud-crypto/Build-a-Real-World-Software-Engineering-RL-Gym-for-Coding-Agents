import * as fs from 'fs';
import * as path from 'path';
import { QueueState } from './types';

export function getReferenceTime(nowArg?: string): Date {
  if (nowArg) {
    const parsed = new Date(nowArg);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  const envNow = process.env.SCHEDULER_FAKE_NOW;
  if (envNow) {
    const parsed = new Date(envNow);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export class Storage {
  public storeDir: string;
  public stateFile: string;
  public logsDir: string;
  public locksDir: string;

  constructor(storeDir: string = './.queue_data') {
    this.storeDir = path.resolve(storeDir);
    this.stateFile = path.join(this.storeDir, 'state.json');
    this.logsDir = path.join(this.storeDir, 'logs');
    this.locksDir = path.join(this.storeDir, 'locks');
    this.ensureDirs();
  }

  public ensureDirs(): void {
    if (!fs.existsSync(this.storeDir)) fs.mkdirSync(this.storeDir, { recursive: true });
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
    if (!fs.existsSync(this.locksDir)) fs.mkdirSync(this.locksDir, { recursive: true });
  }

  public loadState(): QueueState {
    this.ensureDirs();
    if (!fs.existsSync(this.stateFile)) {
      return { jobs: {}, workers: {} };
    }
    try {
      const data = fs.readFileSync(this.stateFile, 'utf-8');
      const parsed = JSON.parse(data);
      return {
        jobs: parsed.jobs || {},
        workers: parsed.workers || {}
      };
    } catch {
      return { jobs: {}, workers: {} };
    }
  }

  public saveState(state: QueueState): void {
    this.ensureDirs();
    const tempFile = path.join(
      this.storeDir,
      `state.json.tmp.${process.pid}.${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    );
    const content = JSON.stringify(state, null, 2);
    fs.writeFileSync(tempFile, content, 'utf-8');
    fs.renameSync(tempFile, this.stateFile);
  }

  public appendLog(jobId: string, timestamp: Date, attempt: number, message: string): void {
    this.ensureDirs();
    const logFile = path.join(this.logsDir, `${jobId}.log`);
    const header = `[${timestamp.toISOString()}] [Attempt ${attempt}] `;
    fs.appendFileSync(logFile, `${header}${message}\n`, 'utf-8');
  }

  public acquireLock(lockName: string): boolean {
    this.ensureDirs();
    const lockPath = path.join(this.locksDir, `${lockName}.lock`);
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}`);
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  public releaseLock(lockName: string): void {
    const lockPath = path.join(this.locksDir, `${lockName}.lock`);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }
}
