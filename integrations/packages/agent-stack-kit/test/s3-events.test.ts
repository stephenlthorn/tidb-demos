import { describe, expect, it } from 'vitest';
import { eventObjectKey, linesToBody, toNdjson } from '../src/s3-events';

describe('toNdjson', () => {
  it('writes one JSON object per line with a trailing newline', () => {
    expect(toNdjson([{ a: 1 }, { b: 'x' }])).toBe('{"a":1}\n{"b":"x"}\n');
  });

  it('writes nothing for no events', () => {
    expect(toNdjson([])).toBe('');
  });
});

describe('linesToBody', () => {
  it('joins lines and ends with a newline', () => {
    expect(linesToBody(['{"a":1}', '{"b":2}'])).toBe('{"a":1}\n{"b":2}\n');
  });
});

describe('eventObjectKey', () => {
  it('builds a sortable key under the prefix', () => {
    expect(eventObjectKey({ prefix: 'agent-coding/events', nowMs: Date.UTC(2026, 9, 17, 10, 0, 0, 250), id: 'abc' })).toBe(
      'agent-coding/events/2026-10-17T10-00-00-250Z-abc.ndjson',
    );
  });

  it('trims slashes from the prefix and supports an empty prefix', () => {
    expect(eventObjectKey({ prefix: '/p/', nowMs: 0, id: 'i' })).toBe('p/1970-01-01T00-00-00-000Z-i.ndjson');
    expect(eventObjectKey({ prefix: '', nowMs: 0, id: 'i' })).toBe('1970-01-01T00-00-00-000Z-i.ndjson');
  });
});
