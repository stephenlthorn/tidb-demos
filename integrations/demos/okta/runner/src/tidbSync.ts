import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { quoteIdentifier } from '@lab/runner-kit';
import type { DbRole } from './groupRoleMap';
import { accountName, roleName, stringLiteral } from './sqlIdentifiers';

const DB_ROLES: readonly DbRole[] = ['analyst', 'engineer'];

const GrantRowsSchema = z.array(z.record(z.string(), z.string()));

export const ensureRoles = async (pool: Pool, schema: string): Promise<void> => {
  const quotedSchema = quoteIdentifier(schema);
  await pool.query(`CREATE ROLE IF NOT EXISTS ${roleName('analyst')}, ${roleName('engineer')}`);
  await pool.query(`GRANT SELECT ON ${quotedSchema}.* TO ${roleName('analyst')}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE ON ${quotedSchema}.* TO ${roleName('engineer')}`);
};

export const provisionUser = async (
  pool: Pool,
  username: string,
  password: string,
  role: DbRole,
): Promise<void> => {
  const account = accountName(username);
  await pool.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${stringLiteral(password)}`);
  await Promise.all(
    DB_ROLES.filter((other) => other !== role).map((other) =>
      pool.query(`REVOKE ${roleName(other)} FROM ${account}`).catch(() => undefined),
    ),
  );
  await pool.query(`GRANT ${roleName(role)} TO ${account}`);
  await pool.query(`SET DEFAULT ROLE ${roleName(role)} TO ${account}`);
};

export const lockAndDropUser = async (pool: Pool, username: string): Promise<void> => {
  const account = accountName(username);
  await pool.query(`ALTER USER ${account} ACCOUNT LOCK`);
  await pool.query(`DROP USER IF EXISTS ${account}`);
};

const grantLinesFor = async (pool: Pool, username: string): Promise<readonly string[]> => {
  try {
    const [rows] = await pool.query(`SHOW GRANTS FOR ${accountName(username)}`);
    return GrantRowsSchema.parse(rows).flatMap((row) => Object.values(row));
  } catch {
    return [];
  }
};

const roleFromGrants = (lines: readonly string[]): DbRole | null =>
  DB_ROLES.find((role) => lines.some((line) => line.includes(`'${role}'`) || line.includes(`\`${role}\``))) ?? null;

export type ActualRoleAssignment = {
  readonly username: string;
  readonly role: DbRole | null;
  readonly exists: boolean;
};

export const readActualAssignments = async (
  pool: Pool,
  usernames: readonly string[],
): Promise<readonly ActualRoleAssignment[]> =>
  Promise.all(
    usernames.map(async (username) => {
      const lines = await grantLinesFor(pool, username);
      return { username, role: roleFromGrants(lines), exists: lines.length > 0 };
    }),
  );
