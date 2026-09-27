import { quoteIdentifier } from '@lab/runner-kit';
import type { DbRole } from './groupRoleMap';

const SAFE_USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

const assertSafeUsername = (username: string): string => {
  if (!SAFE_USERNAME.test(username)) throw new Error(`unsafe username: ${JSON.stringify(username)}`);
  return username;
};

export const toDbUsername = (oktaLogin: string): string =>
  assertSafeUsername((oktaLogin.split('@')[0] ?? '').toLowerCase());

export const accountName = (username: string): string => `${quoteIdentifier(assertSafeUsername(username))}@${quoteIdentifier('%')}`;

export const roleName = (role: DbRole): string => quoteIdentifier(role);

export const stringLiteral = (value: string): string => {
  if (value.includes('\u0000')) throw new Error('literal must not contain a NUL byte');
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
};
