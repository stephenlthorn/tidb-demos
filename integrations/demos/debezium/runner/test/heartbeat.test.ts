import { describe, expect, it } from 'vitest';
import { buildHeartbeatUpsertSql, computeHeartbeatLagMs } from '../src/heartbeat';

describe('buildHeartbeatUpsertSql', () => {
  it('builds an upsert for a single heartbeat row keyed by id=1', () => {
    const built = buildHeartbeatUpsertSql({ sourceCommitMs: 5000 });
    expect(built.sql).toBe(
      'INSERT INTO heartbeat (id, source_commit_ms) VALUES (1, ?) ON DUPLICATE KEY UPDATE source_commit_ms = VALUES(source_commit_ms)',
    );
    expect(built.params).toEqual([5000]);
  });
});

describe('computeHeartbeatLagMs', () => {
  it('returns the gap between observed time and the heartbeat source commit time', () => {
    expect(computeHeartbeatLagMs({ observedAtMs: 5300, sourceCommitMs: 5000 })).toBe(300);
  });

  it('floors negative results at zero for clock-skew safety', () => {
    expect(computeHeartbeatLagMs({ observedAtMs: 4800, sourceCommitMs: 5000 })).toBe(0);
  });
});
