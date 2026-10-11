import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runEvaluation } from './test_runner';

export interface MutantDefinition {
  id: string;
  name: string;
  file: string; // Relative to reference/src/
  targetText: string;
  replacementText: string;
}

const mutants: MutantDefinition[] = [
  {
    id: 'MUT-001',
    name: 'mutant_1_off_by_one_backoff',
    file: 'worker.ts',
    targetText: 'Math.pow(2, freshJob.attempts - 1)',
    replacementText: 'Math.pow(2, freshJob.attempts)'
  },
  {
    id: 'MUT-002',
    name: 'mutant_2_ignore_idempotency_on_retry',
    file: 'queue.ts',
    targetText: 'const idempotencyKey = options.idempotencyKey || null;',
    replacementText: 'const idempotencyKey = null;'
  },
  {
    id: 'MUT-003',
    name: 'mutant_3_heartbeat_resets_visibility_timeout_wrong',
    file: 'worker.ts',
    targetText: 'targetJob.lock_expires_at = new Date(now.getTime() + visibilityTimeout).toISOString();',
    replacementText: 'targetJob.lock_expires_at = new Date(now.getTime() - 10000).toISOString();'
  },
  {
    id: 'MUT-004',
    name: 'mutant_4_extra_retry_before_dlq',
    file: 'worker.ts',
    targetText: 'freshJob.attempts >= freshJob.max_retries',
    replacementText: 'freshJob.attempts > freshJob.max_retries'
  },
  {
    id: 'MUT-005',
    name: 'mutant_5_duplicate_claim_race_condition',
    file: 'worker.ts',
    targetText: "if (job.state === 'processing' && job.lock_expires_at) {",
    replacementText: "if (job.state === 'failed' && job.lock_expires_at) {"
  },
  {
    id: 'MUT-006',
    name: 'mutant_6_scheduled_job_lost_on_crash',
    file: 'queue.ts',
    targetText: 'state.jobs[jobId] = newJob;',
    replacementText: 'if (!delayMs) { state.jobs[jobId] = newJob; }'
  },
  {
    id: 'MUT-007',
    name: 'mutant_7_non_atomic_state_write',
    file: 'storage.ts',
    targetText: 'fs.renameSync(tempFile, this.stateFile);',
    replacementText: 'fs.copyFileSync(tempFile, this.stateFile);'
  }
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

export function runMutantChecks(): boolean {
  const evalDir = getEvaluationDir();
  const rootDir = path.dirname(evalDir);
  const refSrcDir = path.join(rootDir, 'reference', 'src');
  const tempMutantRoot = path.join(evalDir, '.mutant_test_dir');

  console.log('=== STARTING MUTANT VERIFICATION SUITE ===');

  let allCaught = true;

  for (const m of mutants) {
    console.log(`\nTesting Mutant ${m.id} (${m.name})...`);
    
    // Copy reference src to temp directory
    if (fs.existsSync(tempMutantRoot)) {
      fs.rmSync(tempMutantRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(tempMutantRoot, { recursive: true });

    // Copy reference files
    fs.cpSync(refSrcDir, path.join(tempMutantRoot, 'src'), { recursive: true });
    fs.copyFileSync(path.join(rootDir, 'reference', 'package.json'), path.join(tempMutantRoot, 'package.json'));
    fs.copyFileSync(path.join(rootDir, 'reference', 'tsconfig.json'), path.join(tempMutantRoot, 'tsconfig.json'));
    try {
      fs.symlinkSync(path.join(rootDir, 'reference', 'node_modules'), path.join(tempMutantRoot, 'node_modules'), 'junction');
    } catch {
      // ignore
    }

    // Apply mutant change
    const mutantFilePath = path.join(tempMutantRoot, 'src', m.file);
    const originalCode = fs.readFileSync(mutantFilePath, 'utf-8');

    if (!originalCode.includes(m.targetText)) {
      console.error(`ERROR: Target text for mutant ${m.id} not found in ${m.file}!`);
      allCaught = false;
      continue;
    }

    const mutatedCode = originalCode.replace(m.targetText, m.replacementText);
    fs.writeFileSync(mutantFilePath, mutatedCode, 'utf-8');

    // Build mutated code
    try {
      execSync('npx tsc', { cwd: tempMutantRoot, stdio: 'ignore' });
    } catch {
      console.log(`[CAUGHT] Mutant ${m.id} caused compilation failure.`);
      continue;
    }

    // Run verifier score on mutated build
    const mutantCliPath = path.join(tempMutantRoot, 'dist', 'cli.js');
    const result = runEvaluation(mutantCliPath);

    if (result.score < 1.0) {
      console.log(`[CAUGHT] Mutant ${m.id} score dropped to ${result.score} (was 1.0).`);
    } else {
      console.error(`[MISSED] Mutant ${m.id} achieved score ${result.score}! Verifier failed to catch mutant.`);
      allCaught = false;
    }
  }

  // Clean up
  try {
    if (fs.existsSync(tempMutantRoot)) {
      fs.rmSync(tempMutantRoot, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  console.log('\n==========================================');
  if (allCaught) {
    console.log('SUCCESS: All 7 mutants were successfully caught by the verifier suite!');
  } else {
    console.error('FAILURE: Some mutants were missed by the verifier suite.');
  }
  return allCaught;
}

if (require.main === module) {
  const success = runMutantChecks();
  process.exit(success ? 0 : 1);
}
