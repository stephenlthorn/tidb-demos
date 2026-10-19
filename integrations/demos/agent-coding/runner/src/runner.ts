import { createMemory, errorMessage, type Deps, type Stage } from './context';
import { gateControl } from './gates';
import { emptyState } from './state';
import { fanOut } from './stages/fanout';
import { intakeMemoryRecall } from './stages/intake';
import { lakeEval } from './stages/eval';
import { writeLesson } from './stages/lesson';
import { replayFailedStep } from './stages/replay';
import { seedCheckpoint } from './stages/seed';
import { setup } from './stages/setup';
import { winnerPr } from './stages/winner';
import { workLoop } from './stages/workloop';

export type Runner = {
  readonly start: () => Promise<void>;
  readonly onControl: (id: string) => void;
  readonly idle: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
};

const autoPlay: readonly string[] = ['fan-out', 'replay-failed-step', 'run-eval', 'write-lesson'];

export const createRunner = (deps: Deps): Runner => {
  const { emitter, config } = deps;
  const memory = createMemory(emptyState(config.runId));
  const stage: Stage = { deps, memory };
  let queue: Promise<void> = Promise.resolve();

  const execute = async (control: string): Promise<void> => {
    switch (control) {
      case 'inject-flaky-dependency':
        memory.injectFault = true;
        emitter.log('warn', 'flaky dependency armed for the next fan-out', 'harness');
        return;
      case 'fan-out':
        await fanOut(stage);
        await workLoop(stage);
        await winnerPr(stage);
        return;
      case 'replay-failed-step':
        return replayFailedStep(stage);
      case 'run-eval':
        return lakeEval(stage);
      case 'write-lesson':
        return writeLesson(stage);
      default:
        emitter.log('warn', `unknown control: ${control}`);
    }
  };

  const onControl = (control: string): void => {
    const gate = gateControl({ control, done: memory.done });
    if (!gate.run) {
      emitter.log('warn', `${control}: ${gate.reason}`);
      return;
    }
    if (control !== 'inject-flaky-dependency') memory.done = [...memory.done, control];
    queue = queue
      .then(() => execute(control))
      .catch((error: unknown) => {
        emitter.log('error', `${control} failed: ${errorMessage(error)}`);
        emitter.node('harness', 'degraded', errorMessage(error));
      });
  };

  const play = async (remaining: readonly string[]): Promise<void> => {
    const [next, ...rest] = remaining;
    if (next === undefined) return;
    await deps.sleep(config.stagePauseMs);
    onControl(next);
    await queue;
    return play(rest);
  };

  return {
    start: async () => {
      await setup(stage);
      await intakeMemoryRecall(stage);
      await seedCheckpoint(stage);
      emitter.log('info', 'ready: press fan-out (or inject-flaky-dependency first)', 'harness');
      if (config.autoRun) await play(autoPlay);
    },
    onControl,
    idle: () => queue,
    shutdown: async () => {
      await queue;
      await Promise.all(
        memory.state.mounts.map((mountPath) => deps.tiFs.unmount({ mountPath }).catch(() => undefined)),
      );
      await Promise.all(memory.attempts.map((attempt) => attempt.pool?.end().catch(() => undefined)));
      await deps.orgPool.end().catch(() => undefined);
    },
  };
};
