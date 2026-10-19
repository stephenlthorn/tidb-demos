import { describe, expect, it } from 'vitest';
import * as kit from '../src/index';

describe('@lab/agent-stack-kit public surface', () => {
  it('exports exactly the documented runtime names', () => {
    expect(Object.keys(kit).sort()).toEqual([
      'branches',
      'createLakeClient',
      'createS3EventSink',
      'lakeConfigFromEnv',
      'parseBranch',
      'parseCheckpoint',
      'parseJournalVerify',
      'parseLayerDiff',
      'parseLayerId',
      'rfc3339Second',
      'runCli',
      'tiFs',
      'toNdjson',
    ]);
  });

  it('exposes every tiFs method Plan 13 relies on', () => {
    expect(Object.keys(kit.tiFs).sort()).toEqual([
      'appendJournal',
      'checkpoint',
      'commitLayer',
      'createGrant',
      'createJournal',
      'createLayer',
      'deleteLayer',
      'diffLayer',
      'forkLayer',
      'grep',
      'mountLayer',
      'rollbackLayer',
      'unmount',
      'verifyJournal',
    ]);
  });

  it('exposes every branches method Plan 13 relies on', () => {
    expect(Object.keys(kit.branches).sort()).toEqual(['create', 'list', 'remove', 'waitActive']);
  });
});
