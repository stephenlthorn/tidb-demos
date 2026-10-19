import { rfc3339Second } from '@lab/agent-stack-kit';
import type { AttemptRuntime, Stage, StepEntry } from '../context';
import { isInjected, stepKey } from '../context';
import { isolationVerdict } from '../checks';
import { attemptFinishedEvent, stepEvent, type RunEvent } from '../events';
import { readTree, runAttempt, type StepOutcome } from '../harness';
import { pickReplayTarget, pickWinner, scoreAttempt, type AttemptResult } from '../score';
import { pathOwners } from '../scripts';
import { buildSnapshotSql, parseSnapshotRow } from '../snapshot';
import { insertLedgerSql } from '../starterSql';
import { changedPaths, treeHash } from '../tree';
import { withBranch } from '../state';

const pad = (step: number): string => String(step).padStart(2, '0');

const emitRunEvent = async ({ deps, memory }: Stage, event: RunEvent): Promise<void> => {
  await deps.sink.write([JSON.stringify(event)]);
  memory.eventsEmitted += 1;
  memory.firstEventWrittenAtMs ??= Date.now();
  deps.emitter.flow('events-out', 1);
  deps.emitter.metric('events-emitted', memory.eventsEmitted);
};

const afterStep = async (stage: Stage, attempt: AttemptRuntime, outcome: StepOutcome): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, tiFs, orgPool } = deps;
  const pool = attempt.pool;
  if (pool === undefined) throw new Error(`${attempt.script.attemptId} has no branch pool`);
  const checkpointId = `step-${pad(outcome.step)}`;
  const checkpoint = await tiFs.checkpoint({ layerId: attempt.layerId, mountPath: attempt.mountPath, checkpointId });
  emitter.metric('checkpoint-ms', checkpoint.drainMs + checkpoint.checkpointMs);
  emitter.flow('layer-io', 2);
  const snapshot = parseSnapshotRow((await pool.rows(buildSnapshotSql(config.fixtureDatabase)))[0] ?? {});
  emitter.flow('branch-reads', 1);
  const hash = treeHash(await readTree(attempt.repoDir));
  const entry: StepEntry = {
    failing: outcome.test?.failing ?? [],
    signature: outcome.test?.signature,
    treeHash: hash,
    checksum: snapshot.checksum,
    dbTime: snapshot.dbTime,
  };
  memory.stepEntries = new Map([...memory.stepEntries, [stepKey(attempt.script.attemptId, outcome.step), entry]]);
  await Promise.all([
    orgPool.insert(insertLedgerSql, [
      config.runId,
      attempt.script.attemptId,
      outcome.step,
      checkpointId,
      snapshot.dbTime,
      hash,
      snapshot.checksum,
      snapshot.rowCount,
    ]),
    emitRunEvent(stage, stepEvent({ runId: config.runId, script: attempt.script, outcome, nowMs: Date.now() })),
    tiFs.appendJournal({
      journalId: memory.journalId,
      entry: {
        type: 'step.completed',
        status: outcome.halted ? 'failed' : 'ok',
        subjects: [`attempt:${attempt.script.attemptId}`],
        summary: { step: outcome.step, kind: outcome.kind, checkpointId },
      },
      idempotencyKey: `${config.runId}-${attempt.script.attemptId}-${checkpointId}`,
    }),
  ]);
  emitter.flow('step-ledger', 1);
  emitter.log(
    'info',
    `${attempt.script.attemptId} step ${outcome.step} ${outcome.kind}: ${outcome.note}${outcome.test === undefined ? '' : outcome.test.passed ? ' (tests pass)' : ` (${outcome.test.failing.length} failing, ${outcome.test.signature ?? 'unknown'})`}`,
    'harness',
  );
  await deps.sleep(config.stepWaitMs);
};

const passedLastStep = (outcomes: readonly StepOutcome[]): boolean => {
  const last = outcomes.at(-1);
  return last !== undefined && !last.halted && last.test?.passed === true;
};

const playAttempt = async (stage: Stage, attempt: AttemptRuntime): Promise<void> => {
  const { deps, memory } = stage;
  attempt.outcomes = await runAttempt(
    attempt.script,
    { repoDir: attempt.repoDir, fixturesDir: deps.config.fixturesDir, run: deps.run, injectedFault: isInjected(memory, attempt.script.attemptId) },
    (outcome) => afterStep(stage, attempt, outcome),
  );
  attempt.changedFiles = changedPaths(memory.baselineTree, await readTree(attempt.repoDir));
};

const startReplayBranch = (stage: Stage, attempt: AttemptRuntime, entry: StepEntry): void => {
  const { deps, memory } = stage;
  const { config, emitter, branches } = deps;
  const startedAt = Date.now();
  const ready = (async () => {
    const created = await branches.create({
      clusterId: config.fixtureClusterId,
      name: `${config.runId}-replay`,
      parentId: attempt.branchId,
      parentTimestamp: rfc3339Second(entry.dbTime),
    });
    memory.state = withBranch(memory.state, { clusterId: config.fixtureClusterId, branchId: created.branchId });
    await deps.saveState(memory.state);
    const active = await branches.waitActive({
      clusterId: config.fixtureClusterId,
      branchId: created.branchId,
      timeoutMs: config.branchTimeoutMs,
      pollMs: config.branchPollMs,
    });
    emitter.metric('branch-create-s', (Date.now() - startedAt) / 1000);
    emitter.log('info', `replay branch ${created.branchId} ACTIVE (point in time ${rfc3339Second(entry.dbTime)})`, 'fixture-db');
    return active;
  })();
  ready.catch((error: unknown) => emitter.log('error', `replay branch failed: ${error instanceof Error ? error.message : String(error)}`, 'fixture-db'));
  memory.replayBranch = ready;
};

export const workLoop = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, tiFs } = deps;
  emitter.phase('work-loop');
  emitter.check('layer-isolation', 'pending');
  emitter.node('harness', 'busy', `${memory.attempts.length} attempts in parallel`);
  await Promise.all(memory.attempts.map((attempt) => playAttempt(stage, attempt)));

  memory.results = memory.attempts.map((attempt): AttemptResult => ({
    attemptId: attempt.script.attemptId,
    passed: passedLastStep(attempt.outcomes),
    changedFiles: attempt.changedFiles.length,
    steps: attempt.outcomes.length,
  }));
  memory.winner = pickWinner(memory.results);
  memory.results.forEach((result) =>
    emitter.log(
      result.passed ? 'info' : 'warn',
      `${result.attemptId}: ${result.passed ? 'tests pass' : 'failed'}, ${result.changedFiles} files changed, ${result.steps} steps, score ${scoreAttempt(result)} (formula, modeled)`,
      'harness',
    ),
  );
  await Promise.all(
    memory.attempts.map((attempt) =>
      emitRunEvent(
        stage,
        attemptFinishedEvent({
          runId: config.runId,
          script: attempt.script,
          outcomes: attempt.outcomes,
          merged: memory.winner?.attemptId === attempt.script.attemptId,
          nowMs: Date.now(),
        }),
      ),
    ),
  );

  const diffs = Object.fromEntries(
    await Promise.all(
      memory.attempts.map(async (attempt): Promise<readonly [string, readonly string[]]> => [
        attempt.script.attemptId,
        await tiFs.diffLayer({ layerId: attempt.layerId }),
      ]),
    ),
  );
  const isolation = isolationVerdict({ diffs, owners: pathOwners(deps.scripts) });
  emitter.check('layer-isolation', isolation.pass ? 'pass' : 'fail', isolation.observed);

  const halted = memory.attempts.flatMap((attempt) => {
    const last = attempt.outcomes.at(-1);
    return last?.halted === true ? [{ attemptId: attempt.script.attemptId, haltedAtStep: last.step }] : [];
  });
  memory.replayTarget = pickReplayTarget(halted);
  const target = memory.attempts.find((attempt) => attempt.script.attemptId === memory.replayTarget?.attemptId);
  const entry = target === undefined || memory.replayTarget === undefined
    ? undefined
    : memory.stepEntries.get(stepKey(target.script.attemptId, memory.replayTarget.haltedAtStep));
  if (target !== undefined && entry !== undefined) {
    memory.failureMessage = `${entry.signature ?? 'failure'} at step ${memory.replayTarget?.haltedAtStep ?? 0}`;
    startReplayBranch(stage, target, entry);
    emitter.log('info', `${target.script.attemptId} halted at step ${memory.replayTarget?.haltedAtStep}; replay branch requested now so it overlaps with the rest of the run`, 'fixture-db');
  }
  emitter.node('harness', 'healthy');
};
