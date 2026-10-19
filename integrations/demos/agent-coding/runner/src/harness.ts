import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli, type RunCli } from '@lab/agent-stack-kit';
import type { AttemptScript, ScriptStep } from './scripts';
import { parseTap } from './tap';
import type { Tree } from './tree';

export type TestResult = {
  readonly passed: boolean;
  readonly failing: readonly string[];
  readonly passing: number;
  readonly signature: string | undefined;
};

export type StepOutcome = {
  readonly step: number;
  readonly kind: ScriptStep['kind'];
  readonly note: string;
  readonly wrote?: string;
  readonly test?: TestResult;
  readonly halted: boolean;
};

export type StepContext = {
  readonly repoDir: string;
  readonly fixturesDir: string;
  readonly run?: RunCli;
  readonly injectedFault?: boolean;
};

export const runTests = async (options: {
  readonly repoDir: string;
  readonly fault: 'econnreset' | undefined;
  readonly run?: RunCli;
}): Promise<TestResult> => {
  const run = options.run ?? runCli;
  const result = await run({
    bin: process.execPath,
    args: ['--test', '--test-reporter=tap', join(options.repoDir, 'test', 'charge.test.js')],
    env: { GATEWAY_FAULT: options.fault ?? '' },
  });
  const summary = parseTap(result.stdout);
  return {
    passed: result.code === 0 && summary.failing.length === 0,
    failing: summary.failing,
    passing: summary.passing,
    signature: summary.signature,
  };
};

const isFirstVerify = (script: AttemptScript, step: ScriptStep): boolean =>
  script.steps.find((candidate) => candidate.kind === 'verify')?.step === step.step;

const faultFor = (script: AttemptScript, step: ScriptStep, injectedFault: boolean): 'econnreset' | undefined => {
  if (step.kind !== 'baseline' && step.kind !== 'verify') return undefined;
  if (step.fault !== undefined) return step.fault;
  return injectedFault && step.kind === 'verify' && isFirstVerify(script, step) ? 'econnreset' : undefined;
};

export const runStep = async (script: AttemptScript, step: ScriptStep, context: StepContext): Promise<StepOutcome> => {
  const base = { step: step.step, kind: step.kind, note: step.note };
  if (step.kind === 'read') return { ...base, halted: false };
  if (step.kind === 'write') {
    const target = join(context.repoDir, step.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(context.fixturesDir, 'attempts', step.from), target);
    return { ...base, wrote: step.path, halted: false };
  }
  const test = await runTests({
    repoDir: context.repoDir,
    fault: faultFor(script, step, context.injectedFault === true),
    run: context.run,
  });
  return { ...base, test, halted: step.kind === 'verify' && !test.passed };
};

export const runAttempt = async (
  script: AttemptScript,
  context: StepContext,
  afterStep: (outcome: StepOutcome) => Promise<void>,
): Promise<readonly StepOutcome[]> => {
  const walk = async (remaining: readonly ScriptStep[], done: readonly StepOutcome[]): Promise<readonly StepOutcome[]> => {
    const [next, ...rest] = remaining;
    if (next === undefined) return done;
    const outcome = await runStep(script, next, context);
    await afterStep(outcome);
    const finished = [...done, outcome];
    return outcome.halted ? finished : walk(rest, finished);
  };
  return walk(script.steps, []);
};

export const readTree = async (dir: string, prefix = ''): Promise<Tree> => {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const parts = await Promise.all(
    entries
      .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
      .map(async (entry): Promise<Tree> => {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) return readTree(dir, relative);
        return { [relative]: await readFile(join(dir, relative), 'utf8') };
      }),
  );
  return parts.reduce<Tree>((merged, part) => ({ ...merged, ...part }), {});
};
