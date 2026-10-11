import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { test_enqueue_creates_pending_job, test_inspect_returns_counts, test_state_dump_file } from './tests/01_cli_state';
import { test_worker_executes_payload, test_worker_writes_logs } from './tests/02_execution';
import { test_idempotency_key_deduplication, test_dead_letter_idempotency_force } from './tests/03_idempotency';
import { test_exponential_backoff_calculation, test_max_retries_dead_letter_transition, test_admin_retry_command } from './tests/04_backoff_dlq';
import { test_sigkill_visibility_timeout_reclaim } from './tests/05_crash_recovery';
import { test_deterministic_lock_contention } from './tests/06_concurrency';

export interface TestDefinition {
  id: string;
  name: string;
  category: string;
  fn: (cliPath: string, testDir: string) => boolean;
}

const tests: TestDefinition[] = [
  { id: 'CLI-001', name: 'enqueue_creates_pending_job', category: 'cli_state', fn: test_enqueue_creates_pending_job },
  { id: 'CLI-002', name: 'inspect_returns_counts', category: 'cli_state', fn: test_inspect_returns_counts },
  { id: 'CLI-003', name: 'state_dump_file', category: 'cli_state', fn: test_state_dump_file },
  { id: 'EXEC-001', name: 'worker_executes_payload', category: 'execution_logging', fn: test_worker_executes_payload },
  { id: 'EXEC-002', name: 'worker_writes_logs', category: 'execution_logging', fn: test_worker_writes_logs },
  { id: 'IDEM-001', name: 'idempotency_key_deduplication', category: 'idempotency', fn: test_idempotency_key_deduplication },
  { id: 'IDEM-002', name: 'dead_letter_idempotency_force', category: 'idempotency', fn: test_dead_letter_idempotency_force },
  { id: 'RETRY-001', name: 'exponential_backoff_calculation', category: 'backoff_dlq', fn: test_exponential_backoff_calculation },
  { id: 'RETRY-002', name: 'max_retries_dead_letter_transition', category: 'backoff_dlq', fn: test_max_retries_dead_letter_transition },
  { id: 'RETRY-003', name: 'admin_retry_command', category: 'backoff_dlq', fn: test_admin_retry_command },
  { id: 'RECOVER-001', name: 'sigkill_visibility_timeout_reclaim', category: 'visibility_crash_recovery', fn: test_sigkill_visibility_timeout_reclaim },
  { id: 'CONCUR-001', name: 'deterministic_lock_contention', category: 'concurrency_mutex', fn: test_deterministic_lock_contention }
];

function getEvaluationDir(): string {
  let curr = __dirname;
  while (curr && path.basename(curr) !== 'evaluation') {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return curr;
}

export function runEvaluation(targetCliPath: string, scratchDir?: string): { score: number; results: any } {
  const evalDir = getEvaluationDir();
  const scoringYamlPath = path.join(evalDir, 'scoring.yml');
  const scoringContent = fs.readFileSync(scoringYamlPath, 'utf-8');
  const scoringConfig: any = yaml.load(scoringContent);
  const weights: Record<string, number> = scoringConfig.weights;

  const tmpTestDir = scratchDir || path.join(evalDir, '.test_scratch_' + Date.now());
  if (!fs.existsSync(tmpTestDir)) {
    fs.mkdirSync(tmpTestDir, { recursive: true });
  }

  const categoryTotalTests: Record<string, number> = {};
  const categoryPassedTests: Record<string, number> = {};

  for (const cat of Object.keys(weights)) {
    categoryTotalTests[cat] = 0;
    categoryPassedTests[cat] = 0;
  }

  const testResults: any[] = [];

  for (const t of tests) {
    categoryTotalTests[t.category] = (categoryTotalTests[t.category] || 0) + 1;
    let passed = false;
    try {
      passed = t.fn(targetCliPath, tmpTestDir);
    } catch {
      passed = false;
    }
    if (passed) {
      categoryPassedTests[t.category] = (categoryPassedTests[t.category] || 0) + 1;
    }
    testResults.push({ id: t.id, name: t.name, category: t.category, passed });
  }

  let totalScore = 0;
  for (const cat of Object.keys(weights)) {
    const weight = weights[cat] || 0;
    const totalInCat = categoryTotalTests[cat] || 0;
    const passedInCat = categoryPassedTests[cat] || 0;
    if (totalInCat > 0) {
      totalScore += weight * (passedInCat / totalInCat);
    }
  }

  // Cleanup
  try {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    score: parseFloat(totalScore.toFixed(4)),
    results: testResults
  };
}

if (require.main === module) {
  const evalDir = getEvaluationDir();
  const rootDir = path.dirname(evalDir);
  const defaultCli = path.join(rootDir, 'reference', 'dist', 'cli.js');
  const cliPath = process.argv[2] || defaultCli;
  console.log(`Running verifier suite against target: ${cliPath}`);
  const evalResult = runEvaluation(cliPath);
  console.log('Results:', JSON.stringify(evalResult.results, null, 2));
  console.log(`FINAL VERIFIER SCORE: ${evalResult.score}`);
  if (evalResult.score < 1.0) {
    process.exit(1);
  }
}
