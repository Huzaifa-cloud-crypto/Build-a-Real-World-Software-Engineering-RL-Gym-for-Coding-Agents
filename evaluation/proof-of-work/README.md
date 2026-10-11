# Proof-of-Work: AI Model Evaluation Guide & Execution Logs

This directory stores proof-of-work validation artifacts for the **Distributed Job Scheduler** RL Gym benchmark task.

---

## 📁 Directory Files

- `reference_solution_score.json`: Empirical verifier run log of the reference solution (Score: 1.00 / 100%).
- `claude_opus_5_eval.json`: Empirical evaluation run log for Claude Opus 5 (anthropic/claude-opus-5).
- `gpt_5.6_sol_eval.json`: Empirical evaluation run log for GPT-5.6-sol (openai/gpt-5.6-sol).
- `README.md`: Evaluation protocol, prompt template, scoring procedure, and model benchmark status table.

---

## 📊 Model Evaluation Summary Table

| Model | Model ID | Single-Pass Attempts | Build Status | Verifier Score | Difficulty Bar (< 30%) | Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **Reference Solution** | `reference/` | N/A | `SUCCESS` | **1.00 (100%)** | N/A | **VERIFIED (100%)** |
| **Claude Opus 5 (medium reasoning)** | `anthropic/claude-opus-5` | 1 | `SUCCESS` | **0.15 (15%)** | Target: < 0.30 | **PASSES BAR (< 30%)** |
| **GPT-5.6-sol (medium reasoning)** | `openai/gpt-5.6-sol` | 1 | `SUCCESS` | **0.20 (20%)** | Target: < 0.30 | **PASSES BAR (< 30%)** |

---

## 🧬 Mutant Verification Results (100% Catch Rate)

All 7 planted logical regression mutants were verified against the test harness:

| Mutant ID | Name | Targeted Fault | Reference Score | Mutated Score | Result |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **MUT-001** | `mutant_1_off_by_one_backoff` | Off-by-one exponential backoff math `2^n` vs `2^(n-1)` | 1.00 | **0.8667** | **CAUGHT** |
| **MUT-002** | `mutant_2_ignore_idempotency_on_retry` | Ignores client idempotency key | 1.00 | **0.8500** | **CAUGHT** |
| **MUT-003** | `mutant_3_heartbeat_resets_visibility_timeout_wrong` | Visibility lock expires prematurely in the past | 1.00 | **0.9000** | **CAUGHT** |
| **MUT-004** | `mutant_4_extra_retry_before_dlq` | Extra retry before DLQ transition `>` vs `>=` | 1.00 | **0.7917** | **CAUGHT** |
| **MUT-005** | `mutant_5_duplicate_claim_race_condition` | Skips orphaned lock detection on worker crash | 1.00 | **0.8000** | **CAUGHT** |
| **MUT-006** | `mutant_6_scheduled_job_lost_on_crash` | Scheduled jobs with `--delay` not saved | 1.00 | **0.9500** | **CAUGHT** |
| **MUT-007** | `mutant_7_non_atomic_state_write` | Non-atomic write (`copyFileSync` leaving tmp files) | 1.00 | **0.9500** | **CAUGHT** |

---

## 🎯 Benchmark Summary

- **Reference Solution**: Achieves **100% (1.00)** across all 12 acceptance criteria tests.
- **Claude Opus 5 (medium reasoning)**: Achieves **15% (0.15)**, passing the RL gym difficulty bar (< 30%).
- **GPT-5.6-sol (medium reasoning)**: Achieves **20% (0.20)**, passing the RL gym difficulty bar (< 30%).
- **Verifier Rigor**: 100% mutant catch rate (7/7 mutants detected and failed by test assertions).

