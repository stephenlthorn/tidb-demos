import { describe, expect, it } from 'vitest';
import { accountName, roleName, stringLiteral, toDbUsername } from '../src/sqlIdentifiers';

describe('toDbUsername', () => {
  it('derives a lowercase username from an Okta login', () => {
    expect(toDbUsername('Alice.Smith@example.com')).toBe('alice.smith');
  });

  it('rejects logins that would produce an unsafe or too long username', () => {
    expect(() => toDbUsername("x'; DROP USER root; --@example.com")).toThrow('unsafe username');
    expect(() => toDbUsername(`${'a'.repeat(40)}@example.com`)).toThrow('unsafe username');
    expect(() => toDbUsername('@example.com')).toThrow('unsafe username');
  });
});

describe('accountName', () => {
  it('quotes both parts of a TiDB account name', () => {
    expect(accountName('alice.smith')).toBe('`alice.smith`@`%`');
  });

  it('refuses a username that did not pass validation', () => {
    expect(() => accountName('bad`name')).toThrow('unsafe username');
  });
});

describe('roleName', () => {
  it('quotes the two demo roles', () => {
    expect(roleName('analyst')).toBe('`analyst`');
    expect(roleName('engineer')).toBe('`engineer`');
  });
});

describe('stringLiteral', () => {
  it('escapes quotes and backslashes', () => {
    expect(stringLiteral("it's \\ fine")).toBe("'it''s \\\\ fine'");
  });

  it('rejects NUL bytes', () => {
    expect(() => stringLiteral('a\u0000b')).toThrow('literal must not contain a NUL byte');
  });
});
