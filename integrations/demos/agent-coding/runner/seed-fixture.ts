import { createTidbPool } from '@lab/runner-kit';
import { chunk, fixtureStatements, generateOrders, insertOrdersSql, orderRowsAsParams } from './src/fixtureData';
import { buildSnapshotSql, parseSnapshotRow } from './src/snapshot';
import { fromMysql } from './src/sql';

const env = process.env;

const need = (name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const main = async (): Promise<void> => {
  const database = env.FIXTURE_DATABASE === undefined || env.FIXTURE_DATABASE === '' ? 'fixture' : env.FIXTURE_DATABASE;
  const sql = fromMysql(
    createTidbPool({
      ...env,
      TIDB_HOST: need('FIXTURE_HOST'),
      TIDB_PORT: env.FIXTURE_PORT === undefined || env.FIXTURE_PORT === '' ? '4000' : env.FIXTURE_PORT,
      TIDB_USER: need('FIXTURE_ADMIN_USER'),
      TIDB_PASSWORD: need('FIXTURE_ADMIN_PASSWORD'),
      TIDB_DATABASE: 'test',
      TIDB_TLS: 'true',
    }),
  );
  try {
    await fixtureStatements(database).reduce<Promise<void>>(async (previous, statement) => {
      await previous;
      await sql.exec(statement);
    }, Promise.resolve());
    const rows = orderRowsAsParams(generateOrders({ seed: 20261017, count: 2000 }));
    await chunk(rows, 250).reduce<Promise<void>>(async (previous, batch) => {
      await previous;
      await sql.exec(insertOrdersSql(database, batch.length), batch.flat());
    }, Promise.resolve());
    const snapshot = parseSnapshotRow((await sql.rows(buildSnapshotSql(database)))[0] ?? {});
    console.log(`fixture.orders: ${snapshot.rowCount} rows, checksum ${snapshot.checksum}`);
  } finally {
    await sql.end();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
