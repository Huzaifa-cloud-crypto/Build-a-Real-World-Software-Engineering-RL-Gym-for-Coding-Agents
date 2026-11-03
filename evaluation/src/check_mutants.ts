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

export type MutantOutcome = 'CAUGHT' | 'MISSED' | 'ERROR';

export interface MutantResult {
  id: string;
  name: string;
  fault: string;
  outcome: MutantOutcome;
  cleanScore: number;
  mutatedScore: number | null;
  detail: string;
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

/**
 * Link the dependency tree into the mutant workspace. Dependencies may be
 * hoisted to the repository root by npm, so probe both locations. The
 * 'junction' type is Windows-only and silently ignored elsewhere, which
 * previously produced a broken link on Linux.
 */
function linkNodeModules(rootDir: string, tempMutantRoot: string): string | null {
  const candidates = [
    path.join(rootDir, 'reference', 'node_modules'),
    path.join(rootDir, 'node_modules')
  ];

  const source = candidates.find(c => fs.existsSync(path.join(c, 'typescript')));
  if (!source) return null;

  const target = path.join(tempMutantRoot, 'node_modules');
  try {
    fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    try {
      fs.cpSync(source, target, { recursive: true });
    } catch {
      return null;
    }
  }
  return source;
}

export function runMutantChecks(): { allCaught: boolean; results: MutantResult[] } {
  const evalDir = getEvaluationDir();
  const rootDir = path.dirname(evalDir);
  const refSrcDir = path.join(rootDir, 'reference', 'src');
  const tempMutantRoot = path.join(evalDir, '.mutant_test_dir');
  const refCli = path.join(rootDir, 'reference', 'dist', 'cli.js');

  console.log('=== STARTING MUTANT VERIFICATION SUITE ===');

  if (!fs.existsSync(refCli)) {
    console.error(`ERROR: reference build missing at ${refCli}. Run app-setup/build.sh first.`);
    return { allCaught: false, results: [] };
  }

  const cleanScore = runEvaluation(refCli).score;
  console.log(`Clean reference score: ${cleanScore}`);
  if (cleanScore < 1.0) {
    console.error(`ERROR: reference solution scores ${cleanScore}, not 1.0. Mutant results would be meaningless.`);
    return { allCaught: false, results: [] };
  }

  const results: MutantResult[] = [];

  for (const m of mutants) {
    console.log(`\nTesting Mutant ${m.id} (${m.name})...`);

    if (fs.existsSync(tempMutantRoot)) {
      fs.rmSync(tempMutantRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(tempMutantRoot, { recursive: true });

    fs.cpSync(refSrcDir, path.join(tempMutantRoot, 'src'), { recursive: true });
    fs.copyFileSync(path.join(rootDir, 'reference', 'package.json'), path.join(tempMutantRoot, 'package.json'));
    fs.copyFileSync(path.join(rootDir, 'reference', 'tsconfig.json'), path.join(tempMutantRoot, 'tsconfig.json'));

    if (!linkNodeModules(rootDir, tempMutantRoot)) {
      const detail = 'Could not provide node_modules to the mutant workspace; mutant was never built or scored.';
      console.error(`[ERROR] Mutant ${m.id}: ${detail}`);
      results.push({ id: m.id, name: m.name, fault: m.replacementText, outcome: 'ERROR', cleanScore, mutatedScore: null, detail });
      continue;
    }

    const mutantFilePath = path.join(tempMutantRoot, 'src', m.file);
    const originalCode = fs.readFileSync(mutantFilePath, 'utf-8');

    if (!originalCode.includes(m.targetText)) {
      const detail = `Target text not found in ${m.file}; the mutant was never applied. Reference source has drifted from the mutant definition.`;
      console.error(`[ERROR] Mutant ${m.id}: ${detail}`);
      results.push({ id: m.id, name: m.name, fault: m.replacementText, outcome: 'ERROR', cleanScore, mutatedScore: null, detail });
      continue;
    }

    fs.writeFileSync(mutantFilePath, originalCode.replace(m.targetText, m.replacementText), 'utf-8');

    // A mutant that fails to compile proves nothing about the verifier: no
    // assertion ever ran. Report it as an error, never as a catch.
    try {
      execSync('npx --no-install tsc', { cwd: tempMutantRoot, stdio: 'pipe' });
    } catch (err: any) {
      const detail = `Mutated code failed to compile, so the verifier never ran. This is not a catch.\n${err.stdout || err.message}`;
      console.error(`[ERROR] Mutant ${m.id}: ${detail.split('\n')[0]}`);
      results.push({ id: m.id, name: m.name, fault: m.replacementText, outcome: 'ERROR', cleanScore, mutatedScore: null, detail });
      continue;
    }

    const mutantCliPath = path.join(tempMutantRoot, 'dist', 'cli.js');
    if (!fs.existsSync(mutantCliPath)) {
      const detail = 'Compilation reported success but produced no dist/cli.js; the verifier never ran.';
      console.error(`[ERROR] Mutant ${m.id}: ${detail}`);
      results.push({ id: m.id, name: m.name, fault: m.replacementText, outcome: 'ERROR', cleanScore, mutatedScore: null, detail });
      continue;
    }

    const score = runEvaluation(mutantCliPath).score;

    if (score < 1.0) {
      console.log(`[CAUGHT] Mutant ${m.id} score dropped to ${score} (was ${cleanScore}).`);
      results.push({ id: m.id, name: m.name, fault: m.replacementText, outcome: 'CAUGHT', cleanScore, mutatedScore: score, detail: 'Verifier detected the fault.' });
    } else {
      console.error(`[MISSED] Mutant ${m.id} achieved score ${score}! Verifier failed to catch mutant.`);
      results.push({ id: m.id, name: m.name, fault: m.replacementText, outcome: 'MISSED', cleanScore, mutatedScore: score, detail: 'Verifier did not detect the fault.' });
    }
  }

  try {
    if (fs.existsSync(tempMutantRoot)) {
      fs.rmSync(tempMutantRoot, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  const caught = results.filter(r => r.outcome === 'CAUGHT').length;
  const missed = results.filter(r => r.outcome === 'MISSED').length;
  const errored = results.filter(r => r.outcome === 'ERROR').length;
  const allCaught = missed === 0 && errored === 0 && caught === mutants.length;

  // Persist mutant outputs alongside the other proof-of-work artifacts.
  const powDir = path.join(evalDir, 'proof-of-work');
  try {
    fs.mkdirSync(powDir, { recursive: true });
    fs.writeFileSync(
      path.join(powDir, 'mutant_results.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), cleanScore, total: mutants.length, caught, missed, errored, allCaught, results }, null, 2),
      'utf-8'
    );
  } catch {
    // ignore
  }

  console.log('\n==========================================');
  console.log(`Caught: ${caught}/${mutants.length}  Missed: ${missed}  Errors: ${errored}`);
  if (allCaught) {
    console.log(`SUCCESS: All ${mutants.length} mutants were caught by the verifier suite.`);
  } else {
    console.error('FAILURE: Mutant suite is not fully satisfied. Missed mutants mean weak coverage; errors mean the harness itself is broken.');
  }

  return { allCaught, results };
}

if (require.main === module) {
  const { allCaught } = runMutantChecks();
  process.exit(allCaught ? 0 : 1);
}
