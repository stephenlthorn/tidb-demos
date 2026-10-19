import { branches, rfc3339Second, tiFs, type BranchInfo } from '@lab/agent-stack-kit';
import { createTidbPool, timed } from '@lab/runner-kit';
import { branchEnv, branchUser } from '../branchEnv';
import { pointInTimeMs } from '../branchPlan';
import type { Alert } from '../domain';
import { stepsFor, type StepId } from '../fixtures';
import { branchNameFor, casePathFor } from '../journal';
import { buildBandPeersSql, buildAccountLookbackSql, lookbackMonthsToMs } from '../lakeSql';
import { buildRecallQuery, type RecallHit } from '../recallSql';
import { replayHistory, candidateStructuring } from '../rules';
import { DAY_MS, startOfDay } from '../time';
import { elapsedSeconds } from '../tickMath';
import {
  alertVolume,
  execute,
  insertAlerts,
  nonPlantedTransactionCount,
  probeIsolation,
  serverNowMs,
  readAccounts,
  readAlerts,
  readActiveRules,
  readEntityFacts,
  readTransactionsSince,
  readTruth,
  recall,
} from '../starter';
import { caseInsert, ruleUpsert } from '../starterSql';
import { compareRuleVersions, evaluateIsolation } from '../whatIf';
import {
  buildWorkingSet,
  caseIdFor,
  pickCaseAlert,
  renderDraftReport,
  renderNotes,
  summarizePeers,
  type CaseWorkingSet,
  type PeerSummary,
} from '../workingSet';
import { errorMessage, type CaseRecord, type Context } from './context';
import {
  SYNTHETIC_SECRET_VALUE,
  appendCaseJournal,
  openCaseWorkspace,
  readSecretWithGrant,
  writeLayerFile,
  type CaseWorkspace,
} from './filesystem';
import { timedQuery } from './lake';

type StepState = {
  readonly caseId: string;
  readonly alert: Alert;
  readonly workspace: CaseWorkspace;
  readonly peers: PeerSummary | undefined;
  readonly hits: readonly RecallHit[];
  readonly workingSet: CaseWorkingSet | undefined;
};

type Handler = (state: StepState) => Promise<StepState>;

const FIRST_BAND_PCT = 0.9;

const upsertCase = (ctx: Context, record: CaseRecord): void => {
  ctx.cases.update((current) => [...current.filter((item) => item.caseId !== record.caseId), record]);
};

const loadWorkingSetStep = (ctx: Context): Handler => async (state) => {
  const { emitter, pool } = ctx;
  const [accounts, window] = await Promise.all([
    readAccounts(pool),
    readTransactionsSince(pool, state.alert.windowEndMs - 14 * DAY_MS),
  ]);
  const account = accounts.find((item) => item.accountId === state.alert.accountId);
  if (account === undefined) throw new Error(`account ${state.alert.accountId} not found`);
  const facts = await readEntityFacts(pool, account.accountId);
  const flaggedBranches = new Set(
    window.filter((txn) => state.alert.txnIds.includes(txn.txnId)).map((txn) => txn.branchCode),
  );
  return {
    ...state,
    workingSet: buildWorkingSet({
      caseId: state.caseId,
      alert: state.alert,
      account,
      windowTransactions: window,
      recallHits: [],
      peers: state.peers ?? { accountsWithBandActivity: 0, singleBranchAccounts: 0 },
      facts: { ...facts, flagged_branches: String(flaggedBranches.size) },
    }),
  };
};

const recallStep = (ctx: Context): Handler => async (state) => {
  const { emitter, pool } = ctx;
  emitter.phase('recall-similar-cases');
  const workingSet = state.workingSet;
  if (workingSet === undefined) throw new Error('working set must be loaded before recall');
  const queryText = buildRecallQuery({
    pattern: workingSet.pattern,
    accountKind: workingSet.accountKind,
    distinctBranches: workingSet.distinctBranches,
  });
  const { value, ms } = await timed(() => recall(pool, queryText));
  emitter.metric('hybrid-recall-ms', ms);
  emitter.flow('recall-queries', 1);
  emitter.log('info', `hybrid recall returned ${value.length} similar cases in ${ms.toFixed(0)} ms`, 'episodic-memory');
  await appendCaseJournal({ caseId: state.caseId, type: 'recall.completed', summary: `${value.length} similar cases` });
  emitter.flow('audit-entries', 1);
  return { ...state, hits: value, workingSet: { ...workingSet, priorCases: value.map((hit) => ({ caseId: hit.caseId, pattern: hit.pattern, outcome: hit.outcome, rrfScore: hit.rrfScore })) } };
};

const lookbackStep = (ctx: Context): Handler => async (state) => {
  const { emitter, lake, config } = ctx;
  const untilMs = startOfDay(state.alert.windowEndMs) + DAY_MS;
  const sinceMs = untilMs - lookbackMonthsToMs(config.lookbackMonths);
  const thresholdCents = config.thresholdCents;
  const sql =
    state.alert.ruleId === 'structuring'
      ? buildBandPeersSql({
          lowerCents: Math.floor(thresholdCents * FIRST_BAND_PCT),
          upperCents: thresholdCents,
          sinceMs,
          untilMs,
          minDeposits: 3,
        })
      : buildAccountLookbackSql({ accountId: state.alert.accountId, sinceMs, untilMs });
  const { value, ms } = await timedQuery(lake, sql);
  emitter.metric('lake-lookback-ms', ms);
  emitter.flow('lookback-queries', 1);
  const peers = summarizePeers(value);
  emitter.log(
    'info',
    `Lake lookback over ${config.lookbackMonths} months: ${value.length} rows in ${ms.toFixed(0)} ms (${peers.singleBranchAccounts} single-branch peers)`,
    'lake',
  );
  await appendCaseJournal({ caseId: state.caseId, type: 'lookback.completed', summary: `${value.length} history rows` });
  emitter.flow('audit-entries', 1);
  return { ...state, peers };
};

const writeEvidenceStep = (ctx: Context): Handler => async (state) => {
  const { emitter } = ctx;
  const workingSet = state.workingSet;
  if (workingSet === undefined) throw new Error('working set must exist before evidence is written');
  const base = casePathFor(state.caseId);
  const finalSet: CaseWorkingSet = {
    ...workingSet,
    peers: state.peers ?? workingSet.peers,
  };
  await writeLayerFile({ layerId: state.workspace.layerId, remotePath: `${base}/working-set.json`, content: JSON.stringify(finalSet, null, 2) });
  await writeLayerFile({ layerId: state.workspace.layerId, remotePath: `${base}/notes.md`, content: renderNotes(finalSet) });
  await writeLayerFile({ layerId: state.workspace.layerId, remotePath: `${base}/draft-report.md`, content: renderDraftReport(finalSet) });
  emitter.flow('evidence-writes', 3);
  const diff = await tiFs.diffLayer({ layerId: state.workspace.layerId });
  emitter.log('info', `case layer holds ${diff.length} uncommitted changes; the base file system is untouched`, 'case-layers');
  await appendCaseJournal({ caseId: state.caseId, type: 'evidence.written', summary: `${diff.length} files in the case layer` });
  emitter.flow('audit-entries', 1);
  return { ...state, workingSet: finalSet };
};

const awaitOperatorStep = (ctx: Context): Handler => async (state) => {
  ctx.emitter.log('info', 'evidence is ready; Test rule on branch works once the investigation branch is active', 'agent-harness');
  return state;
};

const handlers = (ctx: Context): Readonly<Record<StepId, Handler>> => ({
  'load-working-set': loadWorkingSetStep(ctx),
  'recall-similar-cases': recallStep(ctx),
  'lake-lookback': lookbackStep(ctx),
  'write-evidence': writeEvidenceStep(ctx),
  'test-rule-on-branch': awaitOperatorStep(ctx),
});

export const openInvestigation = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config, fixtures } = ctx;
  const startedAt = Date.now();
  const alerts = await readAlerts(pool);
  const picked = pickCaseAlert({
    alerts,
    preferred: 'structuring',
    excludeAccounts: ctx.cases.get().map((item) => item.alert.accountId),
  });
  if (picked === undefined) {
    emitter.log('warn', 'no open alert to investigate; inject a pattern first', 'agent-harness');
    return;
  }
  const caseId = caseIdFor(ctx.cases.get().length + 1);
  emitter.phase('open-investigation');
  emitter.node('agent-harness', 'busy', `opening ${caseId}`);
  ['case-layers', 'case-journal', 'vault'].forEach((node) => emitter.node(node, 'busy'));
  emitter.node('investigation-branch', 'starting', 'branch creation takes minutes');

  const branchStartedAt = Date.now();
  const pointInTime = pointInTimeMs({
    committedAtMs: ctx.world.get().lastAlertCommitWallMs,
    nowMs: await serverNowMs(pool),
  });
  const branch = await branches.create({
    clusterId: config.clusterId,
    name: branchNameFor(caseId),
    parentTimestamp: rfc3339Second(new Date(pointInTime)),
  });
  emitter.flow('branch-create', 1);
  const branchReady: Promise<BranchInfo> = branches.waitActive({
    clusterId: config.clusterId,
    branchId: branch.branchId,
    timeoutMs: 15 * 60_000,
  });
  branchReady.catch(() => undefined);

  const workspace = await openCaseWorkspace(caseId);
  const layerSeconds = elapsedSeconds(startedAt, Date.now());
  emitter.metric('layer-open-seconds', layerSeconds);
  emitter.flow('vault-grants', 1);
  const secret = await readSecretWithGrant(workspace.grantToken);
  emitter.log(
    secret === SYNTHETIC_SECRET_VALUE ? 'info' : 'warn',
    secret === SYNTHETIC_SECRET_VALUE
      ? 'delegated 10 minute read of the synthetic watchlist secret succeeded'
      : 'delegated read did not return the synthetic secret',
    'vault',
  );
  await appendCaseJournal({ caseId, type: 'case.opened', summary: `layer ${workspace.layerId}, branch ${branch.branchId}` });
  await appendCaseJournal({ caseId, type: 'grant.issued', summary: 'read grant on watchlist-api/KEY, ttl 10m' });
  emitter.flow('audit-entries', 2);
  emitter.check('journal-verifies', 'pending');
  emitter.node('case-layers', 'healthy');
  emitter.node('case-journal', 'healthy');
  emitter.node('vault', 'healthy');
  await execute(
    pool,
    caseInsert({
      caseId,
      accountId: picked.accountId,
      pattern: picked.ruleId,
      openedAtMs: Date.now(),
      layerId: workspace.layerId,
      branchId: branch.branchId,
      journalId: `jrn-${caseId.toLowerCase()}`,
    }),
  );
  upsertCase(ctx, {
    caseId,
    alert: picked,
    layerId: workspace.layerId,
    grantToken: workspace.grantToken,
    branchEndpoint: undefined,
    workingSet: undefined,
    whatIf: undefined,
    shadowAlerts: [],
    skillLayerId: undefined,
    distilled: undefined,
    skillPath: undefined,
    lakeRecallV2: undefined,
  });

  const steps = stepsFor(picked.ruleId, fixtures.playbook);
  const table = handlers(ctx);
  const initial: StepState = { caseId, alert: picked, workspace, peers: undefined, hits: [], workingSet: undefined };
  const finished = await steps.reduce<Promise<StepState>>(
    async (previous, step) => table[step](await previous),
    Promise.resolve(initial),
  );

  emitter.log('info', `waiting for branch ${branch.branchId} to become active`, 'investigation-branch');
  const endpoint = await branchReady;
  const branchSeconds = elapsedSeconds(branchStartedAt, Date.now());
  emitter.metric('branch-create-seconds', branchSeconds);
  emitter.metric('investigation-open-time', elapsedSeconds(startedAt, Date.now()));
  emitter.node('investigation-branch', 'healthy', 'branch active');
  emitter.node('agent-harness', 'healthy', `${caseId} ready for rule test`);
  await appendCaseJournal({ caseId, type: 'branch.ready', summary: `branch active after ${branchSeconds.toFixed(0)} seconds` });
  emitter.flow('audit-entries', 1);
  upsertCase(ctx, {
    caseId,
    alert: picked,
    layerId: workspace.layerId,
    grantToken: workspace.grantToken,
    branchEndpoint: endpoint,
    workingSet: finished.workingSet,
    whatIf: undefined,
    shadowAlerts: [],
    skillLayerId: undefined,
    distilled: undefined,
    skillPath: undefined,
    lakeRecallV2: undefined,
  });
};

export const testRuleOnBranch = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config } = ctx;
  const record = ctx.cases.get().at(-1);
  if (record?.branchEndpoint === undefined) {
    emitter.log('warn', 'open an investigation and wait for its branch before testing a rule', 'agent-harness');
    return;
  }
  const endpoint = record.branchEndpoint;
  emitter.phase('test-rule-on-branch');
  emitter.node('investigation-branch', 'busy', 'testing candidate rule v2');
  if (endpoint.host === undefined || endpoint.port === undefined) {
    throw new Error('the branch did not report a host and port; see Packet 13-V2');
  }
  const branchPool = createTidbPool(
    branchEnv({
      base: process.env,
      host: endpoint.host,
      port: endpoint.port,
      user: branchUser({ userPrefix: endpoint.userPrefix, user: process.env.TIDB_USER ?? '' }),
      password: config.branchPassword === '' ? (process.env.TIDB_PASSWORD ?? '') : config.branchPassword,
      database: ctx.database,
    }),
  );
  try {
    const candidate = candidateStructuring(config.thresholdCents);
    await execute(branchPool, ruleUpsert(candidate));
    emitter.flow('what-if-queries', 1);
    const [transactions, accounts, truth] = await Promise.all([
      readTransactionsSince(branchPool, 0),
      readAccounts(branchPool),
      readTruth(branchPool),
    ]);
    emitter.flow('what-if-queries', 3);
    const lastDayStartMs = startOfDay(transactions.reduce((latest, txn) => Math.max(latest, txn.txnTsMs), 0));
    const shadowAlerts = replayHistory({
      rules: [candidate],
      accounts,
      transactions,
      watchlistCandidates: ctx.world.get().watchlistCandidates,
      firstDayStartMs: config.firstDayStartMs,
      lastDayStartMs,
      lookbackDays: 14,
    });
    await insertAlerts(branchPool, shadowAlerts);
    const volume = await alertVolume(branchPool, 'structuring');
    const [branchAlerts, nonPlanted, branchRules] = await Promise.all([
      readAlerts(branchPool),
      nonPlantedTransactionCount(branchPool),
      readActiveRules(branchPool),
    ]);
    emitter.flow('what-if-queries', 3);
    const result = compareRuleVersions({
      ruleId: 'structuring',
      baselineVersion: 'v1',
      candidateVersion: 'v2',
      alerts: branchAlerts,
      groundTruth: truth,
      nonPlantedTransactionCount: nonPlanted,
    });
    const delta = (volume.get('v2') ?? 0) - (volume.get('v1') ?? 0);
    emitter.metric('rule-change-alert-delta', delta);
    emitter.log(
      delta === result.alertDelta ? 'info' : 'warn',
      `branch alert counts: v1 ${volume.get('v1') ?? 0}, v2 ${volume.get('v2') ?? 0}; decision ${result.decision} (${result.reason}); branch holds ${branchRules.length} active rules`,
      'investigation-branch',
    );
    const [production, onBranch] = await Promise.all([probeIsolation(pool), probeIsolation(branchPool)]);
    const isolation = evaluateIsolation({ production, branch: onBranch });
    emitter.check('investigation-branch-isolated', isolation.isolated ? 'pass' : 'fail', isolation.observed);
    await appendCaseJournal({
      caseId: record.caseId,
      type: 'rule.what-if.completed',
      summary: `structuring v1 ${result.baselineAlerts} to v2 ${result.candidateAlerts} alerts, decision ${result.decision}`,
    });
    emitter.flow('audit-entries', 1);
    upsertCase(ctx, { ...record, whatIf: result, shadowAlerts });
    emitter.node('investigation-branch', 'done', 'what-if complete');
  } catch (error) {
    emitter.log('error', `rule test failed: ${errorMessage(error)}`, 'investigation-branch');
    emitter.node('investigation-branch', 'degraded', errorMessage(error));
    throw error;
  } finally {
    await Promise.race([branchPool.end(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
};
