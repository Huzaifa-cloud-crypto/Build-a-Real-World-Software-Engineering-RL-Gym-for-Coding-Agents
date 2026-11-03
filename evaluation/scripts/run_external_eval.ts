import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, execSync } from 'child_process';
import dotenv from 'dotenv';
import { runEvaluation } from '../src/test_runner';
import * as yaml from 'js-yaml';

/**
 * Single-pass model evaluation driver.
 *
 * Runs each configured frontier model once, through OpenHands as the agent
 * harness, against task/instruction.md inside a sandbox that contains no
 * verifier assets. Builds whatever the agent produced, scores it with the
 * private verifier, and records only measured results.
 *
 * Nothing here synthesises a score. If a run fails, the failure is recorded
 * with a null score and the process exits non-zero.
 */

// Compiled to evaluation/dist/scripts/, so the repo root is three levels up.
const rootDir = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const instructionPath = path.join(rootDir, 'task', 'instruction.md');
const powDir = path.join(rootDir, 'evaluation', 'proof-of-work');
const runRoot = path.join(rootDir, 'temp_model_run');

const DIFFICULTY_BAR = 0.30;

type RunStatus = 'COMPLETED' | 'HARNESS_MISSING' | 'AGENT_FAILED' | 'BUILD_FAILED' | 'CONFIG_ERROR';

interface ModelRunResult {
  model: string;
  modelId: string;
  harness: string;
  command: string;
  status: RunStatus;
  buildStatus: 'SUCCESS' | 'FAILED' | 'NOT_ATTEMPTED';
  score: number | null;
  exitCode: number | null;
  passedTests: string[];
  failedTests: string[];
  failedCategories: string[];
  agentLog: string | null;
  error: string | null;
  timestamp: string;
}

function parseModelList(): Array<{ model: string; modelId: string }> {
  const raw = process.env.EVAL_MODELS;
  if (!raw || !raw.trim()) {
    throw new Error(
      'EVAL_MODELS is not set. Provide two frontier model ids, comma separated, e.g.\n' +
      '  EVAL_MODELS="anthropic/claude-opus-5,openai/gpt-5.6-sol"'
    );
  }
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length !== 2) {
    throw new Error(`EVAL_MODELS must list exactly two models (got ${ids.length}): the brief requires two different frontier models.`);
  }
  return ids.map(id => ({ model: id, modelId: id }));
}

function detectOpenHands(): string | null {
  const explicit = process.env.OPENHANDS_BIN;
  if (explicit) {
    return fs.existsSync(explicit) || !explicit.includes(path.sep) ? explicit : null;
  }
  for (const candidate of ['openhands', 'openhands-cli']) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [candidate], { encoding: 'utf-8' });
    if (probe.status === 0 && probe.stdout.trim()) {
      return probe.stdout.trim().split(/\r?\n/)[0];
    }
  }
  return null;
}

function buildCommand(openhandsBin: string, modelId: string, workspace: string, taskFile: string): string {
  const template = process.env.OPENHANDS_CMD_TEMPLATE;
  if (template) {
    return template
      .replace(/\{bin\}/g, openhandsBin)
      .replace(/\{model\}/g, modelId)
      .replace(/\{workspace\}/g, workspace)
      .replace(/\{task\}/g, taskFile);
  }
  return `"${openhandsBin}" --headless --model "${modelId}" --workspace "${workspace}" --task-file "${taskFile}"`;
}

function prepareWorkspace(slug: string): string {
  const workspace = path.join(runRoot, slug);
  if (fs.existsSync(workspace)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  fs.mkdirSync(workspace, { recursive: true });

  // Model-facing material only. The verifier must never be reachable from
  // the agent's sandbox.
  fs.cpSync(path.join(rootDir, 'task'), path.join(workspace, 'task'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'TASK.md'), fs.readFileSync(instructionPath, 'utf-8'), 'utf-8');

  const leaked = ['evaluation', 'reference'].filter(d => fs.existsSync(path.join(workspace, d)));
  if (leaked.length) {
    throw new Error(`Sandbox leaked private assets into the agent workspace: ${leaked.join(', ')}`);
  }
  return workspace;
}

function findEntrypoint(workspace: string): string | null {
  const candidates = [
    path.join(workspace, 'dist', 'cli.js'),
    path.join(workspace, 'dist', 'src', 'cli.js'),
    path.join(workspace, 'reference', 'dist', 'cli.js'),
    path.join(workspace, 'dist', 'index.js'),
    path.join(workspace, 'cli.js')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function buildAndScore(workspace: string): { buildStatus: 'SUCCESS' | 'FAILED'; entrypoint: string | null; buildError: string | null } {
  const pkg = path.join(workspace, 'package.json');
  if (!fs.existsSync(pkg)) {
    return { buildStatus: 'FAILED', entrypoint: null, buildError: 'Agent produced no package.json.' };
  }

  try {
    execSync('npm install --silent', { cwd: workspace, stdio: 'pipe', timeout: 600000 });
  } catch (err: any) {
    return { buildStatus: 'FAILED', entrypoint: null, buildError: `npm install failed: ${err.message}` };
  }

  try {
    execSync('npm run build', { cwd: workspace, stdio: 'pipe', timeout: 600000 });
  } catch (err: any) {
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n');
    return { buildStatus: 'FAILED', entrypoint: null, buildError: `npm run build failed: ${out.slice(0, 4000)}` };
  }

  const entrypoint = findEntrypoint(workspace);
  if (!entrypoint) {
    return { buildStatus: 'FAILED', entrypoint: null, buildError: 'Build succeeded but no compiled CLI entrypoint (dist/cli.js) was found.' };
  }
  return { buildStatus: 'SUCCESS', entrypoint, buildError: null };
}

function categoriseFailures(results: Array<{ id: string; category: string; passed: boolean }>): string[] {
  return Array.from(new Set(results.filter(r => !r.passed).map(r => r.category))).sort();
}

function runModel(openhandsBin: string | null, model: string, modelId: string, index: number): ModelRunResult {
  const timestamp = new Date().toISOString();
  const base: ModelRunResult = {
    model, modelId,
    harness: 'OpenHands (headless, single pass)',
    command: '',
    status: 'CONFIG_ERROR',
    buildStatus: 'NOT_ATTEMPTED',
    score: null,
    exitCode: null,
    passedTests: [],
    failedTests: [],
    failedCategories: [],
    agentLog: null,
    error: null,
    timestamp
  };

  if (!openhandsBin) {
    return { ...base, status: 'HARNESS_MISSING', error: 'OpenHands CLI not found on PATH. Install it or set OPENHANDS_BIN.' };
  }

  const slug = `model_${index + 1}_${modelId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  let workspace: string;
  try {
    workspace = prepareWorkspace(slug);
  } catch (err: any) {
    return { ...base, status: 'CONFIG_ERROR', error: err.message };
  }

  const taskFile = path.join(workspace, 'TASK.md');
  const command = buildCommand(openhandsBin, modelId, workspace, taskFile);
  const logPath = path.join(workspace, 'openhands_run.log');
  base.command = command;
  base.agentLog = logPath;

  console.log(`\n--> [${index + 1}/2] Single-pass OpenHands run: ${modelId}`);
  console.log(`    workspace: ${workspace}`);
  console.log(`    command:   ${command}`);

  const agent = spawnSync(command, {
    shell: true,
    cwd: workspace,
    encoding: 'utf-8',
    timeout: Number(process.env.EVAL_TIMEOUT_MS || 3600000),
    env: { ...process.env }
  });

  fs.writeFileSync(logPath, [
    `# OpenHands single-pass run`,
    `model: ${modelId}`,
    `command: ${command}`,
    `exitCode: ${agent.status}`,
    ``,
    `## stdout`,
    agent.stdout || '',
    `## stderr`,
    agent.stderr || ''
  ].join('\n'), 'utf-8');

  base.exitCode = agent.status;

  if (agent.error) {
    return { ...base, status: 'AGENT_FAILED', error: `OpenHands invocation failed: ${agent.error.message}` };
  }
  if (agent.status !== 0) {
    return { ...base, status: 'AGENT_FAILED', error: `OpenHands exited ${agent.status}. See ${logPath}` };
  }

  const built = buildAndScore(workspace);
  base.buildStatus = built.buildStatus;
  if (built.buildStatus === 'FAILED' || !built.entrypoint) {
    return { ...base, status: 'BUILD_FAILED', error: built.buildError };
  }

  const evalResult = runEvaluation(built.entrypoint);
  const details = evalResult.results as Array<{ id: string; category: string; passed: boolean }>;

  return {
    ...base,
    status: 'COMPLETED',
    score: evalResult.score,
    passedTests: details.filter(d => d.passed).map(d => d.id),
    failedTests: details.filter(d => !d.passed).map(d => d.id),
    failedCategories: categoriseFailures(details)
  };
}

function recordReferenceRun(): { score: number; results: any[] } {
  const refCli = path.join(rootDir, 'reference', 'dist', 'cli.js');
  if (!fs.existsSync(refCli)) {
    throw new Error(`Reference build missing at ${refCli}. Run app-setup/build.sh first.`);
  }
  const evalResult = runEvaluation(refCli);
  fs.writeFileSync(
    path.join(powDir, 'reference_solution_score.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), target: 'reference_solution', score: evalResult.score, details: evalResult.results }, null, 2),
    'utf-8'
  );
  console.log(`Reference solution score: ${evalResult.score}`);
  return evalResult;
}

function writeReadme(refScore: number, runs: ModelRunResult[]): void {
  const measured = runs.filter(r => r.status === 'COMPLETED' && r.score !== null);
  const barMet = measured.length === 2 && measured.every(r => (r.score as number) < DIFFICULTY_BAR);

  const rows = runs.map(r => {
    const score = r.score === null ? '`NOT MEASURED`' : `**${r.score.toFixed(2)}**`;
    const bar = r.score === null ? 'n/a' : (r.score < DIFFICULTY_BAR ? `below ${DIFFICULTY_BAR} — passes` : `at or above ${DIFFICULTY_BAR} — fails`);
    return `| \`${r.modelId}\` | single-pass | \`${r.status}\` | \`${r.buildStatus}\` | ${score} | ${bar} |`;
  }).join('\n');

  const content = `# Proof-of-Work: Model Evaluation Artifacts

Every number in this directory is measured by an actual run. Nothing is synthesised.

## Artifacts

- \`reference_solution_score.json\` — verifier run against \`reference/\`. Must be \`1.0\`.
- \`mutant_results.json\` — output of \`npm run check:mutants\`, per-mutant outcome and score drop.
- \`model_run_<n>_<id>.json\` — one file per evaluated model: exact OpenHands command, exit code, build status, measured score, per-test results, failure categories.
- \`openhands_run.log\` inside \`temp_model_run/<slug>/\` — full agent transcript per run.

## Reference

| Target | Score |
| :--- | :---: |
| \`reference/\` | **${refScore}** |

## Model runs (single pass, OpenHands harness)

| Model ID | Pass Type | Status | Build | Verifier Score | Difficulty Bar (< ${DIFFICULTY_BAR}) |
| :--- | :---: | :---: | :---: | :---: | :--- |
${rows}

**Difficulty bar verdict:** ${barMet
    ? `MET — both models scored below ${DIFFICULTY_BAR}.`
    : `NOT MET — ${measured.length}/2 models produced a measured score. A run that did not complete cannot be claimed as evidence.`}

## Reproducing

\`\`\`bash
export EVAL_MODELS="<model-a>,<model-b>"   # two different frontier models, medium reasoning
export OPENHANDS_BIN="$(which openhands)"  # optional; auto-detected on PATH
# export OPENHANDS_CMD_TEMPLATE='...'      # optional; pin the exact headless invocation
npm run build && npm run generate
\`\`\`

\`npm run generate\` exits non-zero unless both models completed a single pass and
both measured scores are below ${DIFFICULTY_BAR}.
`;
  fs.writeFileSync(path.join(powDir, 'README.md'), content, 'utf-8');
}

async function main(): Promise<void> {
  console.log('=== SINGLE-PASS MODEL EVALUATION (OpenHands) ===');

  fs.mkdirSync(powDir, { recursive: true });
  fs.mkdirSync(runRoot, { recursive: true });

  const refEval = recordReferenceRun();
  if (refEval.score < 1.0) {
    throw new Error(`Reference solution scores ${refEval.score}, not 1.0. Fix the reference before evaluating models.`);
  }

  let models: Array<{ model: string; modelId: string }>;
  try {
    models = parseModelList();
  } catch (err: any) {
    const result: ModelRunResult = {
      model: 'n/a', modelId: 'n/a', harness: 'OpenHands (headless, single pass)', command: '',
      status: 'CONFIG_ERROR', buildStatus: 'NOT_ATTEMPTED', score: null, exitCode: null,
      passedTests: [], failedTests: [], failedCategories: [], agentLog: null,
      error: err.message, timestamp: new Date().toISOString()
    };
    writeReadme(refEval.score, [result, result]);
    throw err;
  }

  const openhandsBin = detectOpenHands();
  if (!openhandsBin) {
    console.error('OpenHands CLI not found. Install it, or set OPENHANDS_BIN / OPENHANDS_CMD_TEMPLATE.');
  } else {
    console.log(`OpenHands harness: ${openhandsBin}`);
  }

  const runs = models.map((m, i) => runModel(openhandsBin, m.model, m.modelId, i));

  runs.forEach((r, i) => {
    const file = path.join(powDir, `model_run_${i + 1}_${r.modelId.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(r, null, 2), 'utf-8');
    console.log(`\n[${i + 1}/2] ${r.modelId}: status=${r.status} build=${r.buildStatus} score=${r.score === null ? 'NOT MEASURED' : r.score}`);
    if (r.error) console.error(`      error: ${r.error}`);
  });

  writeReadme(refEval.score, runs);

  const completed = runs.filter(r => r.status === 'COMPLETED' && r.score !== null);
  const barMet = completed.length === 2 && completed.every(r => (r.score as number) < DIFFICULTY_BAR);

  console.log('\n=== EVALUATION FINISHED ===');
  if (!barMet) {
    console.error(`Difficulty bar NOT met: ${completed.length}/2 models produced a measured score below ${DIFFICULTY_BAR}.`);
    process.exit(1);
  }
  console.log(`Difficulty bar met: both models scored below ${DIFFICULTY_BAR} on a single pass.`);
}

main().catch(err => {
  console.error('Fatal error in evaluation harness:', err.message || err);
  process.exit(1);
});
