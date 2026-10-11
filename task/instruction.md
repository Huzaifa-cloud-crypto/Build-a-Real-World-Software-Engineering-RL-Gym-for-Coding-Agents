# Distributed Job Scheduler Engine

## Overview
You are tasked with implementing a file-backed, distributed CLI job scheduler / queue engine (`job-queue`). The system manages background job execution across worker processes, supporting retries with exponential backoff, dead-letter queues, idempotency deduplication, worker visibility timeouts, and crash recovery.

---

## Workspace & Storage Layout

All CLI operations accept an optional `--store-dir <path>` parameter (defaulting to `./.queue_data` relative to the current working directory).

The store directory contains:
- `state.json`: The single source of state truth.
- `logs/`: Directory containing job output logs (`logs/<job_id>.log`).
- `locks/`: Directory containing process/job lock files.

### Atomic State Persistence
To prevent corrupted state on process crashes or forced terminations (`SIGKILL`), writes to `state.json` **must be atomic**. Write updated state to a temporary file in the store directory (e.g. `state.json.tmp.<pid>.<timestamp>`) and rename it atomically (`fs.renameSync`) over `state.json`.

---

## Reference Time & Clock Injection (`--now` / `SCHEDULER_FAKE_NOW`)

To ensure determinism during testing and time-based assertions:
1. Every CLI command accepts an optional `--now <ISO8601>` flag (e.g., `--now 2026-09-16T12:00:00.000Z`).
2. If `--now` is not passed as a command-line flag, the program must check the `SCHEDULER_FAKE_NOW` environment variable.
3. If neither is provided, `Date.now()` (current system clock) is used.

All internal timestamps (`created_at`, `updated_at`, `run_at`, `lock_expires_at`, `last_heartbeat_at`) and time checks (backoff delay calculation, visibility timeout expiration, scheduled job eligibility) **must** use this reference time.

---

## State Schema (`state.json`)

The file `state.json` must be structured as follows:

```json
{
  "jobs": {
    "<job_id>": {
      "id": "string",
      "name": "string",
      "queue": "string",
      "payload": {
        "cmd": "string",
        "args": ["string"]
      },
      "state": "pending|processing|completed|failed|dead_letter",
      "attempts": 0,
      "max_retries": 3,
      "claimed_by": "string|null",
      "lock_expires_at": "ISO8601|null",
      "last_heartbeat_at": "ISO8601|null",
      "idempotency_key": "string|null",
      "run_at": "ISO8601|null",
      "created_at": "ISO8601",
      "updated_at": "ISO8601"
    }
  },
  "workers": {
    "<worker_id>": {
      "id": "string",
      "last_heartbeat_at": "ISO8601"
    }
  }
}
```

Field constraints & defaults:
- `queue`: Defaults to `"default"` if not specified.
- `max_retries`: Defaults to `3` if not specified.
- `state`: Must be one of `"pending"`, `"processing"`, `"completed"`, `"failed"`, `"dead_letter"`.

---

## Job Payload & Execution Contract

A job's payload is an object containing `cmd` and optional `args` array:
```json
{
  "cmd": "echo",
  "args": ["Hello", "World"]
}
```

When a worker runs a job:
1. It executes `cmd` with `args` as a child process.
2. If the child process exits with code `0`, the job state transitions to `"completed"`.
3. If the child process exits with code `!= 0`, fails to launch, or times out, the execution is marked as a failure.
4. The stdout and stderr of the process must be appended to `<store-dir>/logs/<job_id>.log` formatted with ISO timestamp headers for each attempt.

---

## CLI Interface Specification

Your CLI executable must accept commands in the following format:

### 1. `enqueue`
Enqueues a new job into the scheduler.

**Flags**:
- `--name <string>` (required): Job name identifier.
- `--payload <json_string>` (optional): Payload JSON object containing `cmd` and `args`. Default: `{"cmd": "echo", "args": []}`.
- `--queue <string>` (optional): Queue name. Default: `"default"`.
- `--delay <ms>` (optional): Delay in milliseconds before job becomes eligible for execution.
- `--max-retries <number>` (optional): Maximum retries before moving to DLQ. Default: `3`.
- `--idempotency-key <string>` (optional): Unique key for deduplication.
- `--force` (optional): Force re-enqueuing a job that exists in `dead_letter` with the same idempotency key.
- `--store-dir <path>` (optional): Path to queue data folder.
- `--now <ISO8601>` (optional): Injected reference time.

**Behavior**:
- `--delay <ms>` sets `run_at = reference_now + delay`. Jobs with `run_at > reference_now` remain `pending` and are not eligible for claim.
- If `--idempotency-key` is provided and a job with that key exists:
  - If state is `"pending"`, `"processing"`, or `"completed"`, `enqueue` returns the existing job ID without creating a duplicate job.
  - If state is `"dead_letter"`, `enqueue` fails (exit code 1) unless `--force` is supplied.
- Output: Print job ID to stdout.
- Exit codes: `0` on success, `1` on error/invalid arguments.

---

### 2. `worker run-once`
Claims and processes up to 1 eligible pending job, then exits.

**Flags**:
- `--worker-id <string>` (required): Worker identifier.
- `--visibility-timeout <ms>` (optional): Visibility lock duration in ms. Default: `30000`.
- `--store-dir <path>` (optional): Path to queue data folder.
- `--now <ISO8601>` (optional): Injected reference time.

**Behavior**:
- Scans jobs in state `"pending"`.
- **Eligibility**: A pending job is eligible for claim only when `run_at <= reference_now` (or `run_at` is `null`).
- Also checks for orphaned `"processing"` jobs whose `lock_expires_at < reference_now` (due to previous worker SIGKILL/crash).
- Claims job atomically: updates state to `"processing"`, sets `claimed_by = worker_id`, sets `lock_expires_at = reference_now + visibility_timeout`, updates `last_heartbeat_at = reference_now`.
- Executes payload.
- On exit 0: updates job state to `"completed"`, clears locks.
- On exit != 0 (failure):
  - Increments `attempts`.
  - If `attempts >= max_retries`: transitions state to `"dead_letter"`.
  - If `attempts < max_retries`: calculates exponential backoff `delay = 1000 * (2 ^ (attempts - 1)) ms`, sets `run_at = reference_now + delay`, and sets state back to `"pending"`.
- Exit codes: `0` if job was processed or no job was ready, `1` on worker initialization error.

---

### 3. `worker start`
Runs a daemon worker loop continuously polling for jobs.

**Flags**:
- `--worker-id <string>` (required): Worker identifier.
- `--visibility-timeout <ms>` (optional): Lock duration in ms. Default: `30000`.
- `--poll-interval <ms>` (optional): Polling interval in ms. Default: `1000`.
- `--queues <q1,q2>` (optional): Comma-separated list of queues to poll.
- `--store-dir <path>` (optional): Store directory path.

**Behavior**:
- Periodically claims jobs, heartbeating every `visibility_timeout / 2` ms to update `last_heartbeat_at` and extend `lock_expires_at`.
- Listens for `SIGINT` / `SIGTERM` signals and exits gracefully after finishing active job processing.
- Exit code: `0` on clean shutdown.

---

### 4. `inspect`
Outputs state summary counts.

**Flags**:
- `--queue <string>` (optional): Filter counts by queue name.
- `--store-dir <path>` (optional)
- `--now <ISO8601>` (optional)

**Behavior**:
Outputs a JSON string to stdout with job counts per state:
```json
{
  "pending": 2,
  "processing": 1,
  "completed": 5,
  "failed": 0,
  "dead_letter": 1
}
```
Exit code: `0`.

---

### 5. `state dump`
Dumps full state.

**Flags**:
- `--file <path>` (required): File path to write complete state JSON.
- `--store-dir <path>` (optional)

**Behavior**:
Reads `state.json` and writes its full contents to `--file <path>`. Exit code `0`.

---

### 6. `retry`
Administrative override to retry a failed or dead-letter job.

**Flags**:
- `--job-id <string>` (required): ID of the job to retry.
- `--store-dir <path>` (optional)
- `--now <ISO8601>` (optional)

**Behavior**:
- Re-enqueues a job in `"failed"` or `"dead_letter"` state back to `"pending"`.
- Resets `attempts` to `0`, sets `run_at = reference_now`, clears `claimed_by` and `lock_expires_at`.
- Preserves the original job ID and idempotency key.
- Exit code: `0` on success, `1` if job is not found or not in `"failed"` / `"dead_letter"` state.

---

### 7. `purge`
Purges matching jobs.

**Flags**:
- `--queue <string>` (optional): Filter by queue.
- `--state <string>` (optional): Filter by state (`completed`, `dead_letter`, etc.).
- `--store-dir <path>` (optional)

**Behavior**:
Removes matching job records from `state.json`. Exit code: `0`.

---

## Edge Case & Failure Semantics Summary

1. **Scheduled Jobs**: `--delay <ms>` sets `run_at = reference_now + delay`. Jobs with `run_at > reference_now` remain `pending` and are not eligible for claim until `run_at <= reference_now`.
2. **SIGKILL Recovery**: When a worker crashes (SIGKILL) while processing a job, its lock expires when `reference_now > lock_expires_at`. The next worker `run-once` or `start` must detect expired locks, reclaim the job, increment `attempts`, and either set state to `"pending"` (if `attempts < max_retries`) or `"dead_letter"` (if `attempts >= max_retries`).
3. **Idempotency Deduplication**: Duplicate enqueues with the same `--idempotency-key` return the original job ID. If the original job is in `"dead_letter"`, re-enqueuing fails unless `--force` is provided.
4. **Exponential Backoff**: Failed attempts calculate `run_at = reference_now + 1000 * (2 ^ (attempts - 1))`.
5. **Atomic State Storage**: `state.json` updates MUST use temporary file creation and atomic rename (`fs.renameSync`).
