import { tiFs } from '@lab/agent-stack-kit';
import { timed } from '@lab/runner-kit';
import type { Alert } from '../domain';
import { buildExportWhere } from '../exportPlan';
import { composeLesson } from '../lesson';
import { journalIdFor, skillsPath } from '../journal';
import { buildRecallQuery } from '../recallSql';
import { countHistoryUpTo, buildPlantedRecallSql, parsePlantedRecall, parseRuleEval, ruleEvalSql, type LakeRuleEval } from '../lakeSql';
import { candidateStructuring, baselineRules } from '../rules';
import { simulateVerdict } from '../scorer';
import { distillSkill, describeRuleChange, lintSkill, type SkillEvidence } from '../skills';
import { flagRow, runEventRow, type FlagScope } from '../sinkRows';
import { skillFileFor } from '../fixtures';
import {
  execute,
  awaitRecallOf,
  maxTxnId,
  readAlerts,
  readTruth,
  recall,
  transactionCountUpTo,
} from '../starter';
import { episodicInsert } from '../starterSql';
import type { CaseRecord, Context } from './context';
import { appendCaseJournal, readBaseFile, writeLayerFile } from './filesystem';
import { awaitRowCount, timedQuery } from './lake';
import { runTransactionExport } from './exports';

const replaceCase = (ctx: Context, record: CaseRecord): void => {
  ctx.cases.update((current) => [...current.filter((item) => item.caseId !== record.caseId), record]);
};

const latestCase = (ctx: Context): CaseRecord | undefined => ctx.cases.get().at(-1);

const emitRunEvent = (ctx: Context, caseId: string, kind: string, detail: string): void => {
  const world = ctx.world.update((current) => ({ ...current, runEventSeq: current.runEventSeq + 1 }));
  ctx.sinks.run.emit(runEventRow({ runId: ctx.runId, seq: world.runEventSeq, kind, caseId, detail, atMs: Date.now() }));
};

const emitFlags = (ctx: Context, alerts: readonly Alert[], scope: FlagScope, truth: Awaited<ReturnType<typeof readTruth>>): number => {
  alerts.forEach((alert) =>
    ctx.sinks.flags.emit(flagRow({ runId: ctx.runId, alert, scope, verdict: simulateVerdict(alert, truth) })),
  );
  return alerts.length;
};

export const recordVerdicts = async (ctx: Context): Promise<void> => {
  const { emitter, pool } = ctx;
  const record = latestCase(ctx);
  if (record === undefined) return;
  emitter.phase('analyst-verdict');
  emitter.node('agent-harness', 'busy', 'simulated analyst verdicts');
  const [production, truth] = await Promise.all([readAlerts(pool), readTruth(pool)]);
  const productionFlags = emitFlags(ctx, production.filter((alert) => alert.ruleVersion === 'v1'), 'production', truth);
  const shadowFlags = emitFlags(ctx, record.shadowAlerts, 'branch-shadow', truth);
  const confirmed = production.filter((alert) => simulateVerdict(alert, truth) === 'confirmed').length;
  emitRunEvent(ctx, record.caseId, 'verdicts.recorded', `${productionFlags} production flags, ${shadowFlags} branch shadow flags`);
  await ctx.sinks.flags.flush();
  await ctx.sinks.run.flush();
  ctx.world.update((current) => ({ ...current, flagsEmitted: current.flagsEmitted + productionFlags + shadowFlags }));
  emitter.flow('run-events', productionFlags + shadowFlags + 1);
  emitter.log(
    'info',
    `simulated analyst verdicts (derived from planted ground truth, labeled simulated): ${confirmed} confirmed, ${production.length - confirmed} false positives`,
    'agent-harness',
  );
  await appendCaseJournal({ caseId: record.caseId, type: 'verdict.recorded', summary: 'simulated verdicts from ground truth' });
  emitter.flow('audit-entries', 1);
};

const precisionOf = (rows: readonly LakeRuleEval[], scope: string, version: string): number | undefined =>
  rows.find((row) => row.ruleId === 'structuring' && row.scope === scope && row.ruleVersion === version)?.precision;

export type LakeEvidence = {
  readonly baselinePrecision: number | undefined;
  readonly candidatePrecision: number | undefined;
  readonly candidateRecall: number | undefined;
};

export const evaluateInLake = async (ctx: Context): Promise<LakeEvidence> => {
  const { emitter, pool, config, lake } = ctx;
  emitter.phase('lake-eval');
  emitter.node('s3-bucket', 'busy', 'second Parquet export');
  const cutoff = await maxTxnId(pool);
  const world = ctx.world.get();
  const exported = await runTransactionExport({
    config,
    database: ctx.database,
    batch: 2,
    afterTxnId: world.exportedUpToTxnId,
    upToTxnId: cutoff,
    log: (message) => emitter.log('info', `${message} [${buildExportWhere({ afterTxnId: world.exportedUpToTxnId, upToTxnId: cutoff })}]`, 's3-bucket'),
  });
  emitter.flow('parquet-export', 1);
  emitter.check('lake-history-matches-export', 'pending');
  emitter.node('lake', 'busy', 'loading exports and events');
  const expected = await transactionCountUpTo(pool, cutoff);
  const loaded = await awaitRowCount({
    lake,
    countSql: countHistoryUpTo(cutoff),
    expected,
    timeoutMs: 8 * 60_000,
    pollMs: 5000,
    kickEveryMs: 45_000,
  });
  const flagsLoaded = await awaitRowCount({
    lake,
    countSql: 'SELECT COUNT(*) AS n FROM harbor.flag_log',
    expected: ctx.world.get().flagsEmitted,
    timeoutMs: 5 * 60_000,
    pollMs: 5000,
    kickEveryMs: 45_000,
  });
  emitter.flow('lake-load', loaded.observed + flagsLoaded.observed);
  emitter.metric('lake-load-seconds', loaded.seconds);
  emitter.check(
    'lake-history-matches-export',
    loaded.reached && loaded.observed === expected ? 'pass' : 'fail',
    `Lake ${loaded.observed} rows, Starter ${expected} rows up to txn_id ${cutoff} (export ${exported.exportId}); flag_log ${flagsLoaded.observed} of ${ctx.world.get().flagsEmitted}`,
  );
  ctx.world.update((current) => ({ ...current, exportedUpToTxnId: cutoff }));

  const evalQuery = await timedQuery(lake, ruleEvalSql);
  const rows = parseRuleEval(evalQuery.value);
  const recallV2 = parsePlantedRecall(await lake.query(buildPlantedRecallSql('v2'))).find((row) => row.pattern === 'structuring');
  emitter.flow('lookback-queries', 2);
  const baselinePrecision = precisionOf(rows, 'production', 'v1');
  const candidatePrecision = precisionOf(rows, 'branch-shadow', 'v2');
  if (baselinePrecision !== undefined) emitter.metric('precision-v1-simulated', baselinePrecision * 100);
  if (candidatePrecision !== undefined) emitter.metric('precision-v2-simulated', candidatePrecision * 100);
  emitter.log(
    'info',
    `Lake eval in ${evalQuery.ms.toFixed(0)} ms: ${rows.map((row) => `${row.ruleId} ${row.ruleVersion} ${row.scope} flags ${row.flags} confirmed ${row.confirmed}`).join('; ')}`,
    'lake',
  );
  emitter.node('s3-bucket', 'healthy');
  emitter.node('lake', 'healthy');
  return { baselinePrecision, candidatePrecision, candidateRecall: recallV2?.recall };
};

export const stageSkillUpdate = async (ctx: Context, lakeEvidence: LakeEvidence): Promise<void> => {
  const { emitter, config } = ctx;
  const record = latestCase(ctx);
  if (record?.whatIf === undefined) {
    emitter.log('warn', 'run the rule test before distilling a skill', 'agent-harness');
    return;
  }
  emitter.phase('distill-commit-skill');
  emitter.node('skills-base', 'busy', 'distilling a skill update in a layer');
  const skillPath = `${skillsPath}/${skillFileFor(record.alert.ruleId)}`;
  const baseline = baselineRules(config.thresholdCents).find((rule) => rule.ruleId === 'structuring');
  const candidate = candidateStructuring(config.thresholdCents);
  if (baseline?.ruleId !== 'structuring' || candidate.ruleId !== 'structuring') throw new Error('structuring rules not found');
  const evidence: SkillEvidence = {
    ruleId: 'structuring',
    baselineVersion: 'v1',
    candidateVersion: 'v2',
    changeSummary: describeRuleChange(baseline.params, candidate.params),
    baselineAlerts: record.whatIf.baselineAlerts,
    candidateAlerts: record.whatIf.candidateAlerts,
    baselinePrecision: lakeEvidence.baselinePrecision,
    candidatePrecision: lakeEvidence.candidatePrecision,
    candidateRecall: lakeEvidence.candidateRecall,
  };
  const current = await readBaseFile(skillPath);
  const distilled = distillSkill({ skillText: current, evidence });
  const layer = await tiFs.createLayer({
    baseRootPath: skillsPath,
    layerName: `skill-${record.caseId.toLowerCase()}`,
    tags: { case: record.caseId },
  });
  await writeLayerFile({ layerId: layer.layerId, remotePath: skillPath, content: distilled.text });
  emitter.flow('evidence-writes', 1);
  const diff = await tiFs.diffLayer({ layerId: layer.layerId });
  emitter.log(
    distilled.lintErrors.length === 0 ? 'info' : 'warn',
    `skill update staged in layer ${layer.layerId}: ${diff.length} change, lint ${distilled.lintErrors.length === 0 ? 'clean' : distilled.lintErrors.join('; ')}. Press Promote skill to commit it to the base file system.`,
    'skills-base',
  );
  await appendCaseJournal({ caseId: record.caseId, type: 'skill.staged', summary: `${skillPath} staged in layer ${layer.layerId}` });
  emitter.flow('audit-entries', 1);
  replaceCase(ctx, { ...record, skillLayerId: layer.layerId, distilled, skillPath, lakeRecallV2: lakeEvidence.candidateRecall });
  emitter.node('skills-base', 'degraded', 'awaiting human approval to promote');
};

const describeChange = (ctx: Context): string => {
  const baseline = baselineRules(ctx.config.thresholdCents).find((rule) => rule.ruleId === 'structuring');
  const candidate = candidateStructuring(ctx.config.thresholdCents);
  if (baseline?.ruleId !== 'structuring' || candidate.ruleId !== 'structuring') return 'no parameter change';
  return describeRuleChange(baseline.params, candidate.params);
};

export const promoteSkill = async (ctx: Context): Promise<void> => {
  const { emitter, pool } = ctx;
  const record = latestCase(ctx);
  if (record?.skillLayerId === undefined || record.distilled === undefined || record.skillPath === undefined || record.whatIf === undefined) {
    emitter.log('warn', 'no staged skill update to promote', 'skills-base');
    return;
  }
  const recallHeld = (record.lakeRecallV2 ?? 0) >= (record.whatIf.baseline.recall ?? 0);
  const lintErrors = lintSkill(record.distilled.text);
  if (record.whatIf.decision !== 'adopt' || !recallHeld || lintErrors.length > 0) {
    emitter.log('warn', `promotion blocked: decision ${record.whatIf.decision}, recall held ${recallHeld}, lint ${lintErrors.join('; ') || 'clean'}`, 'skills-base');
    return;
  }
  emitter.check('skill-commit-lands-on-base', 'pending');
  const skillLayerId = record.skillLayerId;
  const { ms } = await timed(() => tiFs.commitLayer({ layerId: skillLayerId }));
  const onBase = await readBaseFile(record.skillPath);
  const landed = onBase.trim() === record.distilled.text.trim();
  emitter.flow('skill-commits', 1);
  emitter.check(
    'skill-commit-lands-on-base',
    landed ? 'pass' : 'fail',
    `commit-layer took ${ms.toFixed(0)} ms; base ${record.skillPath} ${landed ? 'matches' : 'does not match'} the staged skill`,
  );
  emitter.node('skills-base', 'healthy', 'skill committed by a human decision');
  await appendCaseJournal({ caseId: record.caseId, type: 'skill.promoted', summary: `${record.skillPath} committed to the base file system` });
  emitter.flow('audit-entries', 1);
  emitRunEvent(ctx, record.caseId, 'skill.promoted', record.skillPath);

  emitter.phase('lesson-to-memory');
  emitter.node('episodic-memory', 'busy', 'writing the lesson');
  const lesson = composeLesson({
    caseId: record.caseId,
    pattern: record.alert.ruleId,
    whatIf: record.whatIf,
    changeSummary: describeChange(ctx),
  });
  await execute(pool, episodicInsert([lesson]));
  emitter.flow('lesson-written', 1);
  const queryText = buildRecallQuery({
    pattern: record.alert.ruleId,
    accountKind: record.workingSet?.accountKind ?? 'retail',
    distinctBranches: record.workingSet?.distinctBranches ?? 3,
  });
  const hits = await awaitRecallOf(pool, queryText, record.caseId);
  const recallTiming = await timed(() => recall(pool, queryText));
  emitter.metric('hybrid-recall-ms', recallTiming.ms);
  emitter.flow('recall-queries', 1);
  const rank = hits.findIndex((hit) => hit.caseId === record.caseId) + 1;
  emitter.log('info', rank > 0 ? `the new lesson is retrievable: rank ${rank} of ${hits.length}` : 'the new lesson is not in the top results yet', 'episodic-memory');
  emitter.node('episodic-memory', 'healthy');

  await appendCaseJournal({ caseId: record.caseId, type: 'lesson.recorded', summary: `lesson stored for ${record.caseId}` });
  emitter.flow('audit-entries', 1);
  await ctx.sinks.run.flush();
  const verified = await tiFs.verifyJournal({ journalId: journalIdFor(record.caseId) });
  emitter.check('journal-verifies', verified.ok ? 'pass' : 'fail', verified.ok ? 'hash chain verified' : 'verify-journal reported a problem');
  emitter.node('agent-harness', 'done', `${record.caseId} complete`);
};
