import { describe, expect, it } from 'vitest';
import { failureRows, generateHistory } from '../src/history';

const options = { seed: 42, runs: 50, endMs: Date.UTC(2026, 9, 17) };

describe('generateHistory', () => {
  it('is deterministic for a seed', () => {
    expect(generateHistory(options)).toEqual(generateHistory(options));
  });

  it('writes three attempt rows for every run', () => {
    const events = generateHistory(options);
    expect(events).toHaveLength(150);
    expect(new Set(events.map((event) => event.run_id)).size).toBe(50);
  });

  it('labels every row as synthetic history with a fixture model name', () => {
    const events = generateHistory(options);
    expect(events.every((event) => event.source === 'synthetic-history')).toBe(true);
    expect(events.every((event) => event.model.startsWith('fixture-model-'))).toBe(true);
  });

  it('only merges attempts that passed', () => {
    expect(generateHistory(options).filter((event) => event.merged).every((event) => event.status === 'passed')).toBe(true);
  });

  it('includes gateway reset failures that full-text search can find', () => {
    expect(generateHistory(options).some((event) => event.message.includes('ECONNRESET'))).toBe(true);
  });
});

describe('failureRows', () => {
  it('keeps only failed attempts and embeds their messages', () => {
    const events = generateHistory(options);
    const rows = failureRows(events);
    expect(rows.length).toBe(events.filter((event) => event.status === 'failed').length);
    expect(rows.every((row) => row.vector.length === 64)).toBe(true);
  });
});
