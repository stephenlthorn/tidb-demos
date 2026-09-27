import { describe, expect, it } from 'vitest';
import { createDatabaseSql } from '../src/db-init';

describe('createDatabaseSql', () => {
  it('quotes the database name', () => {
    expect(createDatabaseSql('lab')).toBe('CREATE DATABASE IF NOT EXISTS `lab`');
  });
});
