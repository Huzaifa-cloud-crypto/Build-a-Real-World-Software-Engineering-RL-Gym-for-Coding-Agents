# Real-World Software Engineering RL Gym: Distributed Job Scheduler

A repository-level software engineering evaluation benchmark designed for autonomous AI coding agents in a Reinforcement Learning (RL) Gym environment.

---

## 📌 Overview

This benchmark challenges autonomous coding agents to build a file-backed, distributed CLI job scheduler engine (`job-queue`). The task is designed to be architecturally open-ended while testing strict observable behavioral contracts, including:
- **Deterministic Time Injection**: Mock clock handling via `--now <ISO8601>` and `SCHEDULER_FAKE_NOW`.
- **Atomic State Persistence**: ACID state updates using temporary files and atomic file renames (`fs.renameSync`).
- **Idempotency & Deduplication**: Keyed enqueuing with strict rules for active vs. dead-letter jobs.
- **Exponential Backoff & Dead-Letter Queue (DLQ)**: Mathematical backoff progression `1000 * 2^(attempts - 1)` and automatic DLQ routing.
- **Crash Recovery & Visibility Timeouts**: Unbroken recovery of jobs abandoned mid-flight by crashed/SIGKILL'd workers.
- **Concurrency & Mutex Contention**: Safe multi-worker execution without double-claiming or state corruption.

---

## 📂 Repository Structure

```text
├── task/
│   └── instruction.md        # Model-facing problem specification & CLI requirements
├── reference/                # Ideal, complete reference implementation (100% score)
│   ├── src/
│   │   ├── cli.ts            # Commander-based CLI entry point
│   │   ├── queue.ts          # Queue manager, deduplication, admin operations
│   │   ├── worker.ts         # Worker execution loop, lock management, DLQ routing
│   │   ├── storage.ts        # Atomic state file persistence & logging engine
│   │   └── types.ts          # State and job schemas
│   ├── package.json
│   └── tsconfig.json
├── evaluation/               # Hidden black-box verifier test suite & mutant harness
│   ├── src/
│   │   ├── test_runner.ts    # Main verifier score evaluator
│   │   ├── check_mutants.ts  # Regression mutant verification test harness
│   │   ├── helpers.ts        # CLI process execution & state assertions
│   │   └── tests/            # 12 acceptance criteria test suites
│   ├── proof-of-work/        # Empirical validation run logs & difficulty benchmarks
│   ├── acceptance-criteria.yml # Formal mapping of test IDs & weight categories
│   ├── scoring.yml           # Category weight configurations
│   ├── package.json
│   └── tsconfig.json
├── environment/
│   └── Dockerfile            # Containerized execution environment
└── app-setup/
    ├── build.sh              # Build lifecycle script
    ├── start.sh              # Start lifecycle script
    └── reset.sh              # Reset lifecycle script
```

---

## 🚀 Quick Start

### 1. Install & Build
```bash
# Install root dependencies
npm install

# Build reference and evaluation suites
npm run build
```

### 2. Run the Verifier
Score the reference implementation against the private verifier test suite:
```bash
npm run score
```
*Expected Output: `FINAL VERIFIER SCORE: 1` (100% pass rate)*

### 3. Verify Verifier Rigor (Mutant Testing)
Test all 7 planted logical regression mutants against the test suite to ensure the verifier catches subtle logic errors:
```bash
npm run check:mutants
```
*Expected Output: 100% mutant catch rate (7/7 mutants detected and failed).*

---

## 📊 Benchmark & Evaluation Results

### Model Performance vs. Difficulty Bar (< 30%)

| Candidate / Model | Pass Type | Build Status | Verifier Score | Difficulty Bar (< 30%) |
| :--- | :---: | :---: | :---: | :---: |
| **Reference Solution** | N/A | `SUCCESS` | **1.00 (100%)** | Benchmark Gold Standard |
| **Claude Opus 5 (medium reasoning)** | Single-pass | `SUCCESS` | **0.15 (15%)** | Passed difficulty bar |
| **GPT-5.6-sol (medium reasoning)** | Single-pass | `SUCCESS` | **0.20 (20%)** | Passed difficulty bar |

### Mutant Test Suite Verification (100% Catch Rate)

| Mutant ID | Targeted Regression | Clean Score | Mutated Score | Result |
| :--- | :--- | :---: | :---: | :---: |
| **MUT-001** | Off-by-one exponential backoff math `2^n` vs `2^(n-1)` | 1.00 | **0.8667** | **CAUGHT** |
| **MUT-002** | Ignores client idempotency key | 1.00 | **0.8500** | **CAUGHT** |
| **MUT-003** | Visibility lock expires prematurely in the past | 1.00 | **0.9000** | **CAUGHT** |
| **MUT-004** | Extra retry before DLQ transition (`>` vs `>=`) | 1.00 | **0.7917** | **CAUGHT** |
| **MUT-005** | Skips orphaned lock detection upon worker crash | 1.00 | **0.8000** | **CAUGHT** |
| **MUT-006** | Scheduled jobs with `--delay` not saved | 1.00 | **0.9500** | **CAUGHT** |
| **MUT-007** | Non-atomic write (`copyFileSync` leaving temp files) | 1.00 | **0.9500** | **CAUGHT** |

---

## 🐳 Docker Containerization

To run the entire suite in an isolated Linux environment:

```bash
docker build -t rl-gym-job-scheduler -f environment/Dockerfile .
docker run --rm rl-gym-job-scheduler
```
