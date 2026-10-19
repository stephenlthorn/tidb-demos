import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { timed } from '@lab/runner-kit';
import { errorMessage, type AttemptRuntime, type Stage } from '../context';
import { assertBranchHeadroom } from '../gates';
import { chunk } from '../fixtureData';
import { failureRows, generateHistory } from '../history';
import { buildFailureInsert, lakeBootstrapStatements, lakeSetupStatements } from '../lakeSql';
import { withBranch, withJournal, withLayer } from '../state';
import { createLedgerSql, createMemoriesSql, insertMemorySql, seedMemories } from '../starterSql';

const startAttemptBranch = (stage: Stage, attempt: AttemptRuntime): void => {
  const { deps, memory } = stage;
  const { config, emitter, branches } = deps;
  const startedAt = Date.now();
  const ready = (async () => {
    const created = await branches.create({
      clusterId: config.fixtureClusterId,
      name: `${config.runId}-${attempt.script.attemptId}`,
    });
    attempt.branchId = created.branchId;
    memory.state = withBranch(memory.state, { clusterId: config.fixtureClusterId, branchId: created.branchId });
    await deps.saveState(memory.state);
    emitter.log('info', `${attempt.script.attemptId}: branch ${created.branchId} requested (${created.state})`, 'fixture-db');
    const active = await branches.waitActive({
      clusterId: config.fixtureClusterId,
      branchId: created.branchId,
      timeoutMs: config.branchTimeoutMs,
      pollMs: config.branchPollMs,
    });
    emitter.metric('branch-create-s', (Date.now() - startedAt) / 1000);
    emitter.log('info', `${attempt.script.attemptId}: branch ${created.branchId} is ACTIVE`, 'fixture-db');
    return active;
  })();
  ready.catch((error: unknown) => emitter.log('error', `${attempt.script.attemptId}: branch failed: ${errorMessage(error)}`, 'fixture-db'));
  attempt.branchReady = ready;
};

const loadHistory = async (stage: Stage): Promise<void> => {
  const { config, emitter, sink, lake } = stage.deps;
  const events = generateHistory({ seed: config.historySeed, runs: config.historyRuns, endMs: Date.now() });
  await Promise.all(chunk(events, 500).map((batch) => sink.write(batch.map((event) => JSON.stringify(event)))));
  await Promise.all(chunk(failureRows(events), 40).map((batch) => lake.query(buildFailureInsert(batch))));
  emitter.flow('events-out', events.length);
  emitter.log('info', `loaded ${events.length} synthetic history rows (labelled synthetic-history)`, 's3-events');
};

export const setup = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, orgPool, tiFs, branches, lake, lakeBootstrap } = deps;
  emitter.phase('setup');
  ['harness', 'fixture-repo', 'filesystem', 'fixture-db', 'org-memory', 'ledger', 's3-events', 'lake', 'eval'].forEach((node) =>
    emitter.node(node, 'starting'),
  );
  await mkdir(config.workDir, { recursive: true });

  const existing = await branches.list({ clusterId: config.fixtureClusterId });
  assertBranchHeadroom({ existing: existing.length, needed: deps.scripts.length + 1, quota: config.branchQuota });

  const attempts: readonly AttemptRuntime[] = deps.scripts.map((script) => ({
    script,
    mountPath: join(config.workDir, script.attemptId),
    repoDir: join(config.workDir, script.attemptId, 'payments-api'),
    layerId: '',
    branchId: '',
    branchReady: undefined,
    pool: undefined,
    outcomes: [],
    changedFiles: [],
  }));
  memory.attempts = attempts;
  attempts.forEach((attempt) => startAttemptBranch(stage, attempt));
  emitter.node('fixture-db', 'busy', `creating ${attempts.length} attempt branches (takes minutes)`);

  await orgPool.exec(createMemoriesSql);
  await orgPool.exec(createLedgerSql);
  const [counted] = await orgPool.rows('SELECT COUNT(*) AS n FROM memories');
  if (Number(counted?.n ?? 0) === 0) {
    await Promise.all(seedMemories.map((text) => orgPool.insert(insertMemorySql, ['org', text])));
    emitter.log('info', `seeded ${seedMemories.length} org memories`, 'org-memory');
  }
  emitter.node('org-memory', 'healthy');
  emitter.node('ledger', 'healthy');

  await Promise.all(lakeBootstrapStatements({ database: config.lakeDatabase }).map((sql) => lakeBootstrap.query(sql)));
  const { ms: lakeMs } = await timed(async () => {
    const statements = lakeSetupStatements({
      warehouse: config.lakeWarehouse,
      database: config.lakeDatabase,
      bucket: config.bucket,
      prefix: `${config.prefix}/${config.runId}`,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    });
    await statements.reduce<Promise<void>>(async (previous, sql) => {
      await previous;
      await lake.query(sql);
    }, Promise.resolve());
  });
  emitter.log('info', `Lake objects ready in ${Math.round(lakeMs)} ms; task ingest_run_events resumed`, 'lake');
  await loadHistory(stage);
  emitter.node('lake', 'healthy');
  emitter.node('s3-events', 'healthy');
  emitter.node('eval', 'idle');

  const layer = await tiFs.createLayer({
    baseRootPath: '/workspace',
    layerName: `task-${config.ticket.id.toLowerCase()}-${config.runId}`,
    tags: { ticket: config.ticket.id, run: config.runId },
  });
  memory.taskLayerId = layer.layerId;
  memory.state = withLayer(memory.state, layer.layerId);
  memory.journalId = config.runId;
  memory.state = withJournal(memory.state, memory.journalId);
  await deps.saveState(memory.state);
  await tiFs.createJournal({ journalId: memory.journalId, journalKind: 'agent', title: `${config.ticket.id} ${config.ticket.title}` });
  await tiFs.appendJournal({
    journalId: memory.journalId,
    entry: { type: 'run.started', subjects: [`ticket:${config.ticket.id}`], summary: { runId: config.runId } },
    idempotencyKey: `${config.runId}-started`,
  });
  emitter.node('filesystem', 'healthy', `task layer ${layer.layerId}`);
  emitter.node('fixture-repo', 'healthy');
  emitter.node('harness', 'healthy');
  emitter.log('info', `task layer ${layer.layerId}, journal ${memory.journalId}`, 'filesystem');
};
