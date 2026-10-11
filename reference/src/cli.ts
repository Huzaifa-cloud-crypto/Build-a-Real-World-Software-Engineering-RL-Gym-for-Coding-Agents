#!/usr/bin/env node
import { Command } from 'commander';
import { enqueueJob, inspectState, dumpState, retryJob, purgeJobs } from './queue';
import { runWorkerOnce, startWorkerDaemon } from './worker';

const program = new Command();
program
  .name('job-queue')
  .description('Distributed Job Scheduler CLI')
  .version('0.1.0');

program
  .command('enqueue')
  .description('Enqueue a job')
  .requiredOption('--name <name>', 'Job name')
  .option('--payload <json>', 'Payload JSON string')
  .option('--queue <queue>', 'Queue name', 'default')
  .option('--delay <ms>', 'Delay in milliseconds')
  .option('--max-retries <n>', 'Maximum retries', '3')
  .option('--idempotency-key <key>', 'Idempotency key')
  .option('--force', 'Force re-enqueue dead-letter job')
  .option('--store-dir <path>', 'Store directory', './.queue_data')
  .option('--now <iso>', 'Reference timestamp')
  .action((options) => {
    try {
      let payloadParsed = { cmd: 'echo', args: [] };
      if (options.payload) {
        payloadParsed = JSON.parse(options.payload);
      }
      const res = enqueueJob({
        name: options.name,
        payload: payloadParsed,
        queue: options.queue,
        delayMs: options.delay ? parseInt(options.delay, 10) : undefined,
        maxRetries: options.maxRetries ? parseInt(options.maxRetries, 10) : undefined,
        idempotencyKey: options.idempotencyKey,
        force: options.force,
        storeDir: options.storeDir,
        now: options.now
      });
      console.log(res.jobId);
      process.exit(0);
    } catch (err: any) {
      console.error(err.message || err);
      process.exit(1);
    }
  });

const workerCmd = program.command('worker').description('Worker operations');

workerCmd
  .command('run-once')
  .description('Claim and process a single job')
  .requiredOption('--worker-id <id>', 'Worker ID')
  .option('--visibility-timeout <ms>', 'Visibility timeout in ms')
  .option('--store-dir <path>', 'Store directory', './.queue_data')
  .option('--now <iso>', 'Reference timestamp')
  .action(async (options) => {
    try {
      await runWorkerOnce({
        workerId: options.workerId,
        visibilityTimeoutMs: options.visibilityTimeout ? parseInt(options.visibilityTimeout, 10) : undefined,
        storeDir: options.storeDir,
        now: options.now
      });
      process.exit(0);
    } catch (err: any) {
      console.error(err.message || err);
      process.exit(1);
    }
  });

workerCmd
  .command('start')
  .description('Start worker polling loop')
  .requiredOption('--worker-id <id>', 'Worker ID')
  .option('--visibility-timeout <ms>', 'Visibility timeout in ms')
  .option('--poll-interval <ms>', 'Poll interval in ms')
  .option('--queues <queues>', 'Comma separated queues')
  .option('--store-dir <path>', 'Store directory', './.queue_data')
  .action(async (options) => {
    try {
      const queues = options.queues ? options.queues.split(',') : undefined;
      await startWorkerDaemon({
        workerId: options.workerId,
        visibilityTimeoutMs: options.visibilityTimeout ? parseInt(options.visibilityTimeout, 10) : undefined,
        pollIntervalMs: options.pollInterval ? parseInt(options.pollInterval, 10) : undefined,
        queues,
        storeDir: options.storeDir
      });
      process.exit(0);
    } catch (err: any) {
      console.error(err.message || err);
      process.exit(1);
    }
  });

program
  .command('inspect')
  .description('Inspect job queue state counts')
  .option('--queue <queue>', 'Queue filter')
  .option('--store-dir <path>', 'Store directory', './.queue_data')
  .option('--now <iso>', 'Reference timestamp')
  .action((options) => {
    try {
      const counts = inspectState(options.queue, options.storeDir, options.now);
      console.log(JSON.stringify(counts, null, 2));
      process.exit(0);
    } catch (err: any) {
      console.error(err.message || err);
      process.exit(1);
    }
  });

program
  .command('state')
  .command('dump')
  .description('Dump complete state JSON to file')
  .requiredOption('--file <path>', 'Target JSON output file')
  .option('--store-dir <path>', 'Store directory', './.queue_data')
  .action((options) => {
    try {
      dumpState(options.file, options.storeDir);
      process.exit(0);
    } catch (err: any) {
      console.error(err.message || err);
      process.exit(1);
    }
  });

program
  .command('retry')
  .description('Retry a failed or dead-letter job')
  .requiredOption('--job-id <id>', 'Job ID')
  .option('--store-dir <path>', 'Store directory', './.queue_data')
  .option('--now <iso>', 'Reference timestamp')
  .action((options) => {
    try {
      retryJob(options.jobId, options.storeDir, options.now);
      process.exit(0);
    } catch (err: any) {
      console.error(err.message || err);
      process.exit(1);
    }
  });

program
  .command('purge')
  .description('Purge matching jobs')
  .option('--queue <queue>', 'Queue filter')
  .option('--state <state>', 'State filter')
  .option('--store-dir <path>', 'Store directory', './.queue_data')
  .action((options) => {
    try {
      purgeJobs(options.queue, options.state, options.storeDir);
      process.exit(0);
    } catch (err: any) {
      console.error(err.message || err);
      process.exit(1);
    }
  });

program.parse(process.argv);
