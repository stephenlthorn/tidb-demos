import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { createTidbPool, tidbConfigFromEnv } from '@lab/runner-kit';
import { createPgClient, type PgClient } from '../runner/src/pg-client';
import { buildChecksumQuery, type ChecksumColumn } from '../runner/src/checksum';

type MysqlPool = ReturnType<typeof createTidbPool>;
type ChecksumRow = RowDataPacket & { readonly checksum: number | string };

type Fixture = {
  readonly table: string;
  readonly primaryKey: string;
  readonly columns: readonly ChecksumColumn[];
};

const accountColumns: readonly ChecksumColumn[] = [
  { column: 'external_ref', type: 'text' },
  { column: 'display_name', type: 'text' },
  { column: 'is_active', type: 'boolean' },
  { column: 'metadata', type: 'json' },
  { column: 'opened_at', type: 'timestamptz' },
];

const orderColumns: readonly ChecksumColumn[] = [
  { column: 'order_id', type: 'text' },
  { column: 'account_id', type: 'text' },
  { column: 'amount', type: 'numeric', precision: 18, scale: 2 },
  { column: 'currency', type: 'text' },
  { column: 'status', type: 'text' },
  { column: 'placed_at', type: 'timestamptz' },
];

const heartbeatColumns: readonly ChecksumColumn[] = [
  { column: 'heartbeat_id', type: 'text' },
  { column: 'inserted_at', type: 'timestamptz' },
];

const probeColumns: readonly ChecksumColumn[] = [
  { column: 'txt_col', type: 'text' },
  { column: 'bool_col', type: 'boolean' },
  { column: 'ts_col', type: 'timestamptz' },
  { column: 'num_col', type: 'numeric', precision: 18, scale: 4 },
  { column: 'json_col', type: 'json' },
  { column: 'select', type: 'text' },
];

const fixtures: readonly Fixture[] = [
  { table: 'accounts', primaryKey: 'account_id', columns: accountColumns },
  { table: 'orders', primaryKey: 'order_id', columns: orderColumns },
  { table: 'heartbeat', primaryKey: 'heartbeat_id', columns: heartbeatColumns },
  { table: 'checksum_probe', primaryKey: 'probe_id', columns: probeColumns },
];

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

const toUtcDatetime = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
  `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

const readSql = (relativePath: string): string => readFileSync(new URL(relativePath, import.meta.url), 'utf-8');

const runIntegration = process.env.LAB_INTEGRATION === '1';

describe.skipIf(!runIntegration)('checksum cross-engine parity', () => {
  let pg: Client;
  let pgClient: PgClient;
  let tidb: MysqlPool;
  let orderIds: readonly number[] = [];

  beforeAll(async () => {
    pg = new Client({
      host: process.env.PG_HOST,
      port: Number(process.env.PG_PORT ?? 5432),
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      database: process.env.PG_DATABASE,
    });
    await pg.connect();
    pgClient = createPgClient(process.env);
    tidb = createTidbPool(process.env);
    await tidb.query("SET time_zone = '+00:00'");

    await pg.query('DROP TABLE IF EXISTS orders, accounts, heartbeat, checksum_probe CASCADE');
    await pg.query(readSql('../infra/sql/schema.sql'));
    await pg.query(
      'CREATE TABLE checksum_probe (probe_id BIGSERIAL PRIMARY KEY, txt_col TEXT, bool_col BOOLEAN, ' +
        'ts_col TIMESTAMPTZ, num_col NUMERIC(18,4), json_col JSONB, "select" TEXT)',
    );

    const schemaConnection = await mysql.createConnection({ ...tidbConfigFromEnv(process.env), multipleStatements: true });
    await schemaConnection.query('DROP TABLE IF EXISTS orders, accounts, heartbeat, checksum_probe');
    await schemaConnection.query(readSql('../infra/sql/schema-tidb.sql'));
    await schemaConnection.query(
      'CREATE TABLE checksum_probe (probe_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, txt_col TEXT, ' +
        'bool_col BOOLEAN, ts_col DATETIME, num_col NUMERIC(18,4), json_col JSON, `select` TEXT)',
    );
    await schemaConnection.end();

    type AccountFixture = {
      readonly display_name: string;
      readonly is_active: boolean;
      readonly risk_tags: string;
      readonly metadata: string;
      readonly opened_at: string;
    };

    const accountsFixture: readonly AccountFixture[] = [
      {
        display_name: 'acct-alpha',
        is_active: true,
        risk_tags: '{}',
        metadata: '{}',
        opened_at: '2024-01-15T10:30:00+09:00',
      },
      {
        display_name: "acct-o'brien café 中文",
        is_active: false,
        risk_tags: '{high,watch}',
        metadata:
          '{"zeta": 1, "alpha": {"nested_b": 2.50000, "nested_a": [3,2,1]}, "beta": "café 中文", "esc": "a\\"b\\\\c"}',
        opened_at: '2024-06-01T23:59:59-05:00',
      },
      {
        display_name: 'acct-gamma',
        is_active: true,
        risk_tags: '{}',
        metadata: '{"a": 1, "aa": 2, "ab": 3, "b": 4}',
        opened_at: '2024-03-03T00:00:00Z',
      },
    ];

    type InsertedAccount = AccountFixture & { readonly account_id: number; readonly external_ref: string; readonly opened_at_utc: Date };
    const insertedAccounts: InsertedAccount[] = [];

    for (const fixture of accountsFixture) {
      type InsertedAccountRow = { readonly account_id: number; readonly external_ref: string; readonly opened_at: Date };
      const result = await pg.query<InsertedAccountRow>(
        'INSERT INTO accounts (display_name, is_active, risk_tags, metadata, opened_at) ' +
          'VALUES ($1, $2, $3::text[], $4::jsonb, $5::timestamptz) ' +
          'RETURNING account_id, external_ref, opened_at',
        [fixture.display_name, fixture.is_active, fixture.risk_tags, fixture.metadata, fixture.opened_at],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('account insert returned no row');
      insertedAccounts.push({ ...fixture, account_id: row.account_id, external_ref: row.external_ref, opened_at_utc: row.opened_at });
    }

    for (const account of insertedAccounts) {
      await tidb.query(
        'INSERT INTO accounts (account_id, external_ref, display_name, is_active, risk_tags, metadata, opened_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          account.account_id,
          account.external_ref,
          account.display_name,
          account.is_active,
          account.risk_tags.replaceAll('{', '').replaceAll('}', ''),
          account.metadata,
          toUtcDatetime(account.opened_at_utc),
        ],
      );
    }

    const firstAccountId = insertedAccounts[0]?.account_id;
    const secondAccountId = insertedAccounts[1]?.account_id;
    const thirdAccountId = insertedAccounts[2]?.account_id;
    if (firstAccountId === undefined || secondAccountId === undefined || thirdAccountId === undefined) {
      throw new Error('expected three fixture accounts');
    }

    type OrderFixture = {
      readonly account_id: number;
      readonly amount: string;
      readonly currency: string;
      readonly status: string;
      readonly placed_at: string;
    };

    const ordersFixture: readonly OrderFixture[] = [
      { account_id: firstAccountId, amount: '19.90', currency: 'USD', status: 'placed', placed_at: '2024-01-16T00:00:00+00:00' },
      { account_id: secondAccountId, amount: '100.00', currency: 'EUR', status: 'refunded', placed_at: '2024-06-02T05:00:00.250+00:00' },
      { account_id: thirdAccountId, amount: '-5.75', currency: 'USD', status: 'cancelled', placed_at: '2024-03-04T12:00:00+00:00' },
    ];

    type InsertedOrder = OrderFixture & { readonly order_id: number; readonly placed_at_utc: Date };
    const insertedOrders: InsertedOrder[] = [];

    for (const fixture of ordersFixture) {
      type InsertedOrderRow = { readonly order_id: number; readonly placed_at: Date };
      const result = await pg.query<InsertedOrderRow>(
        'INSERT INTO orders (account_id, amount, currency, status, placed_at) VALUES ($1,$2,$3,$4,$5::timestamptz) ' +
          'RETURNING order_id, placed_at',
        [fixture.account_id, fixture.amount, fixture.currency, fixture.status, fixture.placed_at],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('order insert returned no row');
      insertedOrders.push({ ...fixture, order_id: row.order_id, placed_at_utc: row.placed_at });
    }

    for (const order of insertedOrders) {
      await tidb.query('INSERT INTO orders (order_id, account_id, amount, currency, status, placed_at) VALUES (?, ?, ?, ?, ?, ?)', [
        order.order_id,
        order.account_id,
        order.amount,
        order.currency,
        order.status,
        toUtcDatetime(order.placed_at_utc),
      ]);
    }
    orderIds = insertedOrders.map((order) => order.order_id);

    type InsertedHeartbeatRow = { readonly heartbeat_id: number; readonly inserted_at: Date };
    const heartbeatResult = await pg.query<InsertedHeartbeatRow>(
      'INSERT INTO heartbeat (inserted_at) VALUES (now()) RETURNING heartbeat_id, inserted_at',
    );
    const heartbeatRow = heartbeatResult.rows[0];
    if (heartbeatRow === undefined) throw new Error('heartbeat insert returned no row');
    await tidb.query('INSERT INTO heartbeat (heartbeat_id, inserted_at) VALUES (?, ?)', [
      heartbeatRow.heartbeat_id,
      toUtcDatetime(heartbeatRow.inserted_at),
    ]);

    await pg.query(
      'INSERT INTO checksum_probe (txt_col, bool_col, ts_col, num_col, json_col, "select") ' +
        'VALUES (NULL, NULL, NULL, NULL, NULL, NULL)',
    );
    await tidb.query(
      'INSERT INTO checksum_probe (txt_col, bool_col, ts_col, num_col, json_col, `select`) VALUES (NULL, NULL, NULL, NULL, NULL, NULL)',
    );

    type InsertedProbeRow = { readonly probe_id: number; readonly ts_col: Date };
    const populatedProbe = await pg.query<InsertedProbeRow>(
      'INSERT INTO checksum_probe (txt_col, bool_col, ts_col, num_col, json_col, "select") ' +
        'VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb, $6) RETURNING probe_id, ts_col',
      [
        'unicode café 中文 with a \'quote\' and a "dquote"',
        false,
        '2024-09-09T09:09:09.900+05:30',
        '12.340000',
        '{"zeta": 1, "alpha": {"nested_b": 2, "nested_a": [3,2,1]}, "unicode": "café 中文", "esc": "a\\"b\\\\c"}',
        'reserved word column',
      ],
    );
    const populatedProbeRow = populatedProbe.rows[0];
    if (populatedProbeRow === undefined) throw new Error('probe insert returned no row');
    await tidb.query(
      'INSERT INTO checksum_probe (txt_col, bool_col, ts_col, num_col, json_col, `select`) VALUES (?, ?, ?, ?, ?, ?)',
      [
        'unicode café 中文 with a \'quote\' and a "dquote"',
        false,
        toUtcDatetime(populatedProbeRow.ts_col),
        '12.340000',
        '{"zeta": 1, "alpha": {"nested_b": 2, "nested_a": [3,2,1]}, "unicode": "café 中文", "esc": "a\\"b\\\\c"}',
        'reserved word column',
      ],
    );
  });

  afterAll(async () => {
    await pgClient.close();
    await pg.end();
    await tidb.end();
  });

  it.each(fixtures)('$table produces an equal checksum on postgres and tidb', async ({ table, primaryKey, columns }) => {
    const pgChecksum = await pgClient.runChecksum({ table, primaryKey, columns });
    const mysqlQuery = buildChecksumQuery({ dialect: 'mysql', table, primaryKey, columns });
    const [tidbRows] = await tidb.query<ChecksumRow[]>(mysqlQuery);
    const tidbRow = tidbRows[0];
    if (tidbRow === undefined) throw new Error(`no checksum row for ${table}`);
    const tidbChecksum = Number(tidbRow.checksum);

    console.log(`checksum[${table}] pg=${pgChecksum} tidb=${tidbChecksum}`);
    expect(tidbChecksum).toBe(pgChecksum);
  });

  it('stays deterministic when the tidb session time zone is not UTC', async () => {
    await tidb.query("SET time_zone = '+09:00'");
    const query = buildChecksumQuery({ dialect: 'mysql', table: 'orders', primaryKey: 'order_id', columns: orderColumns });
    const [rows] = await tidb.query<ChecksumRow[]>(query);
    const row = rows[0];
    if (row === undefined) throw new Error('no checksum row for orders');
    const pgChecksum = await pgClient.runChecksum({ table: 'orders', primaryKey: 'order_id', columns: orderColumns });
    console.log(`checksum[orders] non-utc-session pg=${pgChecksum} tidb=${Number(row.checksum)}`);
    expect(Number(row.checksum)).toBe(pgChecksum);
    await tidb.query("SET time_zone = '+00:00'");
  });

  it('detects a mutated row on the tidb side as a checksum mismatch', async () => {
    const query = { table: 'orders', primaryKey: 'order_id', columns: orderColumns };
    const beforePg = await pgClient.runChecksum(query);
    const mysqlQuery = buildChecksumQuery({ dialect: 'mysql', ...query });
    const [beforeRows] = await tidb.query<ChecksumRow[]>(mysqlQuery);
    const beforeRow = beforeRows[0];
    if (beforeRow === undefined) throw new Error('no checksum row for orders');
    expect(Number(beforeRow.checksum)).toBe(beforePg);

    const mutatedOrderId = orderIds[0];
    if (mutatedOrderId === undefined) throw new Error('expected at least one fixture order');
    await tidb.query('UPDATE orders SET status = ? WHERE order_id = ?', ['MUTATED', mutatedOrderId]);

    const [afterRows] = await tidb.query<ChecksumRow[]>(mysqlQuery);
    const afterRow = afterRows[0];
    if (afterRow === undefined) throw new Error('no checksum row for orders');
    console.log(`checksum[orders] after mutation pg=${beforePg} tidb=${Number(afterRow.checksum)}`);
    expect(Number(afterRow.checksum)).not.toBe(beforePg);

    await tidb.query('UPDATE orders SET status = ? WHERE order_id = ?', ['placed', mutatedOrderId]);
  });

  it('never lets a NULL boolean on the postgres side collide with a stored false value', async () => {
    const expression = "CASE WHEN bool_col IS NULL THEN NULL WHEN bool_col THEN '1' ELSE '0' END";
    type SingleRow = { readonly txt: string | null };
    const nullRow = await pg.query<SingleRow>(`SELECT ${expression} AS txt FROM checksum_probe WHERE bool_col IS NULL LIMIT 1`);
    const falseRow = await pg.query<SingleRow>(`SELECT ${expression} AS txt FROM checksum_probe WHERE bool_col = false LIMIT 1`);
    expect(nullRow.rows[0]?.txt).toBeNull();
    expect(falseRow.rows[0]?.txt).toBe('0');
  });
});
