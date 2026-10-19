import { describe, expect, it } from 'vitest';
import { buildSnapshotSql, normalizeDbTime, parseSnapshotRow } from '../src/snapshot';

describe('normalizeDbTime', () => {
  it('trims microseconds to milliseconds', () => {
    expect(normalizeDbTime('2026-10-17T10:00:00.250000Z')).toBe('2026-10-17T10:00:00.250Z');
  });

  it('pads a short fraction', () => {
    expect(normalizeDbTime('2026-10-17T10:00:00.5Z')).toBe('2026-10-17T10:00:00.500Z');
  });

  it('adds a zero fraction when none is present', () => {
    expect(normalizeDbTime('2026-10-17T10:00:00Z')).toBe('2026-10-17T10:00:00.000Z');
  });

  it('rejects other formats', () => {
    expect(() => normalizeDbTime('2026-10-17 10:00:00')).toThrow('unexpected db_time format');
  });
});

describe('buildSnapshotSql', () => {
  it('quotes the database and checksums every column that defines a row', () => {
    const sql = buildSnapshotSql('fixture');
    expect(sql).toContain('FROM `fixture`.orders');
    expect(sql).toContain("CRC32(CONCAT_WS('|', id, customer, amount_cents, status))");
    expect(sql).toContain('UTC_TIMESTAMP(3)');
  });

  it('escapes a hostile database name', () => {
    expect(buildSnapshotSql('a`b')).toContain('FROM `a``b`.orders');
  });
});

describe('parseSnapshotRow', () => {
  it('normalises a database row', () => {
    expect(
      parseSnapshotRow({ db_time: '2026-10-17T10:00:00.250000Z', row_count: '2000', checksum: '1234567890' }),
    ).toEqual({ dbTime: '2026-10-17T10:00:00.250Z', rowCount: 2000, checksum: '1234567890' });
  });

  it('rejects a row count that is not an integer', () => {
    expect(() => parseSnapshotRow({ db_time: '2026-10-17T10:00:00Z', row_count: 'x', checksum: '1' })).toThrow(
      'unexpected row_count',
    );
  });
});
