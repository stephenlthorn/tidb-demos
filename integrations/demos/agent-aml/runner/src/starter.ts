import type { Pool } from 'mysql2/promise';
import { sleep } from '@lab/runner-kit';
import { z } from 'zod';
import type { Account, Alert, GroundTruthEntry, Transaction, WatchlistEntry } from './domain';
import { ftsQueryFromName } from './names';
import { buildHybridRecallSql, recallHitFromRow, type RecallHit } from './recallSql';
import { accountFromRow, alertFromRow, groundTruthFromRow, transactionFromRow, watchlistEntryFromRow } from './rowMappers';
import { retryUntil } from './retry';
import { parseRuleRow, type RuleDefinition } from './rules';
import { resetStatements, schemaStatements } from './schema';
import {
  accountInsert,
  alertInsert,
  alertVolumeByVersion,
  chunk,
  countNonPlantedTransactions,
  countTransactionsUpTo,
  entityFactsInsert,
  groundTruthInsert,
  isolationProbe,
  maxTransactionId,
  selectAccounts,
  selectActiveRules,
  selectAlerts,
  selectEntityFacts,
  selectGroundTruth,
  selectTransactionsSince,
  selectWatchlistCandidates,
  transactionInserts,
  type Statement,
} from './starterSql';
import { formatDateTimeMs } from './time';
import { parseDateTime } from './time';
import type { IsolationProbe } from './whatIf';

export type StarterPool = Pool;

type Row = Readonly<Record<string, unknown>>;

const HeaderSchema = z.object({ affectedRows: z.number() });

export const rowsOf = async (pool: StarterPool, sql: string, params: readonly unknown[] = []): Promise<readonly Row[]> => {
  const [rows] = await pool.query(sql, [...params]);
  return z.array(z.looseObject({})).parse(rows);
};

export const execute = async (pool: StarterPool, statement: Statement): Promise<number> => {
  if (statement.sql === '') return 0;
  const [header] = await pool.query(statement.sql, [...statement.params]);
  return HeaderSchema.parse(header).affectedRows;
};

const countOf = async (pool: StarterPool, sql: string, params: readonly unknown[] = []): Promise<number> => {
  const [row] = await rowsOf(pool, sql, params);
  return Number(row?.n ?? 0);
};

export const ensureSchema = async (pool: StarterPool, reset: boolean): Promise<void> => {
  await schemaStatements.reduce(async (previous, sql) => {
    await previous;
    await pool.query(sql);
  }, Promise.resolve());
  if (!reset) return;
  await resetStatements.reduce(async (previous, sql) => {
    await previous;
    await pool.query(sql);
  }, Promise.resolve());
};

export const insertTransactions = async (pool: StarterPool, transactions: readonly Transaction[]): Promise<number> => {
  const counts = await transactionInserts(transactions).reduce<Promise<number>>(
    async (previous, statement) => (await previous) + (await execute(pool, statement)),
    Promise.resolve(0),
  );
  return counts;
};

export const insertPeople = async (pool: StarterPool, accounts: readonly Account[]): Promise<void> => {
  await execute(pool, accountInsert(accounts));
  await execute(pool, entityFactsInsert(accounts));
};

export const insertTruth = (pool: StarterPool, truth: readonly GroundTruthEntry[]): Promise<number> =>
  execute(pool, groundTruthInsert(truth));

export const insertAlerts = (pool: StarterPool, alerts: readonly Alert[]): Promise<number> =>
  chunk(alerts, 200).reduce<Promise<number>>(
    async (previous, batch) => (await previous) + (await execute(pool, alertInsert(batch))),
    Promise.resolve(0),
  );

export const readTransactionsSince = async (pool: StarterPool, sinceMs: number): Promise<readonly Transaction[]> =>
  (await rowsOf(pool, selectTransactionsSince, [formatDateTimeMs(sinceMs)])).map(transactionFromRow);

export const readAccounts = async (pool: StarterPool): Promise<readonly Account[]> =>
  (await rowsOf(pool, selectAccounts)).map(accountFromRow);

export const readTruth = async (pool: StarterPool): Promise<readonly GroundTruthEntry[]> =>
  (await rowsOf(pool, selectGroundTruth)).map(groundTruthFromRow);

export const readAlerts = async (pool: StarterPool): Promise<readonly Alert[]> =>
  (await rowsOf(pool, selectAlerts)).map(alertFromRow);

export const readActiveRules = async (pool: StarterPool): Promise<readonly RuleDefinition[]> =>
  (await rowsOf(pool, selectActiveRules)).map(parseRuleRow);

export const readEntityFacts = async (pool: StarterPool, entityId: string): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    (await rowsOf(pool, selectEntityFacts, [entityId])).map((row): readonly [string, string] => [
      String(row.fact_key),
      String(row.fact_value),
    ]),
  );

export const nonPlantedTransactionCount = (pool: StarterPool): Promise<number> =>
  countOf(pool, countNonPlantedTransactions);

export const transactionCountUpTo = (pool: StarterPool, txnId: number): Promise<number> =>
  countOf(pool, countTransactionsUpTo, [txnId]);

export const serverNowMs = async (pool: StarterPool): Promise<number> => {
  const [row] = await rowsOf(pool, "SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%d %H:%i:%s.%f') AS now_text");
  return parseDateTime(String(row?.now_text));
};

export const maxTxnId = async (pool: StarterPool): Promise<number> => {
  const [row] = await rowsOf(pool, maxTransactionId);
  return Number(row?.max_id ?? 0);
};

export const alertVolume = async (pool: StarterPool, ruleId: string): Promise<ReadonlyMap<string, number>> =>
  new Map(
    (await rowsOf(pool, alertVolumeByVersion, [ruleId])).map((row): readonly [string, number] => [
      String(row.rule_version),
      Number(row.alerts),
    ]),
  );

export const probeIsolation = async (pool: StarterPool): Promise<IsolationProbe> => {
  const [row] = await rowsOf(pool, isolationProbe);
  return { v2Rules: Number(row?.v2_rules ?? 0), v2Alerts: Number(row?.v2_alerts ?? 0) };
};

export const screenAccounts = async (
  pool: StarterPool,
  accounts: readonly Account[],
): Promise<ReadonlyMap<string, readonly WatchlistEntry[]>> => {
  const screenOne = async (account: Account): Promise<readonly [string, readonly WatchlistEntry[]]> => {
    const query = ftsQueryFromName(account.holderName);
    if (query === '') return [account.accountId, []];
    const rows = await rowsOf(pool, selectWatchlistCandidates(query));
    return [account.accountId, rows.map(watchlistEntryFromRow)];
  };
  const entries = await chunk(accounts, 8).reduce<Promise<readonly (readonly [string, readonly WatchlistEntry[]])[]>>(
    async (previous, batch) => [...(await previous), ...(await Promise.all(batch.map(screenOne)))],
    Promise.resolve([]),
  );
  return new Map(entries.filter(([, hits]) => hits.length > 0));
};

export const recall = async (pool: StarterPool, queryText: string): Promise<readonly RecallHit[]> =>
  (await rowsOf(pool, buildHybridRecallSql({ queryText }))).map(recallHitFromRow);

export const awaitWatchlistEntry = async (pool: StarterPool, fullName: string): Promise<boolean> => {
  const query = ftsQueryFromName(fullName);
  const found = await retryUntil({
    attempt: async () => {
      const rows = await rowsOf(pool, selectWatchlistCandidates(query));
      return rows.some((row) => row.full_name === fullName) ? true : undefined;
    },
    tries: 30,
    delayMs: 2000,
    pause: sleep,
  });
  return found === true;
};

export const awaitRecallOf = async (pool: StarterPool, queryText: string, caseId: string): Promise<readonly RecallHit[]> => {
  const hits = await retryUntil({
    attempt: async () => {
      const result = await recall(pool, queryText);
      return result.some((hit) => hit.caseId === caseId) ? result : undefined;
    },
    tries: 10,
    delayMs: 3000,
    pause: sleep,
  });
  return hits ?? recall(pool, queryText);
};
