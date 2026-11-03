# Real-World Software Engineering RL Gym: Distributed Job Scheduler

A repository-level software engineering benchmark for autonomous AI coding agents in a
Reinforcement Learning Gym environment.

---

## Overview

The agent is handed [`task/instruction.md`](task/instruction.md) and must build `job-queue`,
a file-backed distributed CLI job scheduler, from scratch. The internal architecture is
left open; the observable contract is pinned exactly, and a private black-box verifier
scores the result.

Behaviours under test:

- **Deterministic time injection** — `--now <ISO8601>` and `SCHEDULER_FAKE_NOW` drive every timestamp and time comparison.
- **Atomic state persistence** — temp file plus `fs.renameSync`; no leftover temporaries.
- **Idempotency and deduplication** — keyed enqueue, with `--force` required to revive a dead-letter job.
- **Exponential backoff and DLQ** — `1000 * 2^(attempts - 1)`, then dead-letter routing at `attempts >= max_retries`.
- **Crash recovery** — jobs abandoned by a SIGKILL'd worker are reclaimed once `lock_expires_at` passes.
- **Concurrency** — a store-wide mutex prevents double-claiming and lost writes.

---

## Repository structure

```text
├── task/
│   ├── instruction.md           # Model-facing specification
│   └── public/                  # Public starter materials (none required; greenfield)
├── environment/
│   └── Dockerfile               # Model sandbox. Verifier is NOT baked in.
├── reference/                   # Reference solution (scores 1.00)
│   └── src/{cli,queue,worker,storage,types}.ts
├── evaluation/                  # Private verifier
│   ├── src/tests/               # 12 black-box checks across 6 files
│   ├── src/test_runner.ts       # Weighted scorer
│   ├── src/check_mutants.ts     # Mutant harness
│   ├── scripts/run_external_eval.ts  # OpenHands single-pass model driver
│   ├── acceptance-criteria.yml  # Requirement -> test ID mapping
│   ├── scoring.yml              # Category weights (sum = 1.00)
│   └── proof-of-work/           # Measured artifacts only
├── app-setup/{build,start,reset}.sh
└── package.json
```

---

## Quick start

```bash
npm install                 # root + reference deps (postinstall)
bash app-setup/build.sh     # builds reference and, when present, the verifier
npm run check:reference     # -> FINAL VERIFIER SCORE: 1
npm run check:mutants       # -> Caught: 7/7  Missed: 0  Errors: 0
```

`app-setup/build.sh` works under any invocation form — relative, `./`, or absolute.

### Root scripts

| Script | Purpose |
| :--- | :--- |
| `npm run build` | Compile `reference/` and `evaluation/` |
| `npm run generate` | Single-pass model evaluation via OpenHands; writes measured logs |
| `npm run score` | Score the CLI at `argv[2]`, defaulting to the reference build |
| `npm run check:mutants` | Verify all 7 mutants are caught |
| `npm run check:reference` | Verify the reference scores 1.00 |

---

## Evaluation status

### Reference solution — verified

| Target | Build | Score | Tests |
| :--- | :---: | :---: | :---: |
| `reference/` | SUCCESS | **1.00** | 12 / 12 |

Deterministic: repeated verifier runs return an identical score.

### Mutant suite — verified, 7/7 caught

| Mutant | Targeted fault | Clean | Mutated | Outcome |
| :--- | :--- | :---: | :---: | :---: |
| MUT-001 | Off-by-one backoff, `2^n` vs `2^(n-1)` | 1.00 | 0.8667 | CAUGHT |
| MUT-002 | Idempotency key discarded | 1.00 | 0.8500 | CAUGHT |
| MUT-003 | Visibility lock set in the past | 1.00 | 0.9000 | CAUGHT |
| MUT-004 | Extra retry before DLQ, `>` vs `>=` | 1.00 | 0.7917 | CAUGHT |
| MUT-005 | Orphaned-lock reclaim skipped | 1.00 | 0.8000 | CAUGHT |
| MUT-006 | `--delay` jobs never persisted | 1.00 | 0.9500 | CAUGHT |
| MUT-007 | Non-atomic write leaves temp files | 1.00 | 0.9500 | CAUGHT |

A mutant that fails to compile is reported as an **error**, not a catch, and fails the
suite — a non-building mutant proves nothing about the verifier.

### Model evaluation — pending

**No model scores are recorded.** The brief requires two different frontier models at
medium reasoning, single pass through OpenHands, both below 30%. That requires
OpenHands plus model credentials, which are not available in this environment.

`npm run generate` will not fabricate a result. Without a harness it exits non-zero
and records `status: HARNESS_MISSING`, `score: null`. To run it:

```bash
cp .env.example .env        # set EVAL_MODELS and credentials
npm run generate
```

See [`evaluation/proof-of-work/README.md`](evaluation/proof-of-work/README.md).

---

## Scoring

Score = Σ over categories of `weight × (passed / total)`.

| Category | Weight | Tests |
| :--- | :---: | :---: |
| cli_state | 0.15 | 3 |
| execution_logging | 0.20 | 2 |
| idempotency | 0.15 | 2 |
| backoff_dlq | 0.20 | 3 |
| visibility_crash_recovery | 0.20 | 1 |
| concurrency_mutex | 0.10 | 1 |
| **Total** | **1.00** | **12** |

---

## Docker

The image contains **model-facing assets only**. The private verifier is deliberately
excluded and bind-mounted at scoring time, so an agent working inside the sandbox
cannot read the tests it is being graded by.

```bash
docker build -t rl-gym-job-scheduler -f environment/Dockerfile .

# Agent sandbox (idle shell; the solution is written into /workspace/reference/)
docker run --rm -it rl-gym-job-scheduler

# Score a run: mount the verifier, then build and score inside the container
docker run --rm \
  -v "$PWD/evaluation:/workspace/evaluation" \
  rl-gym-job-scheduler \
  bash -c "bash app-setup/build.sh && npm run score"
```

---

## Privacy

- `evaluation/` is never copied into the model sandbox image.
- The agent workspace assembled by `npm run generate` is checked before the run and
  the harness aborts if `evaluation/` or `reference/` is reachable from it.
- The repository itself must be **private**, with collaborator access granted to
  `content.team@problemsetters.com`.
