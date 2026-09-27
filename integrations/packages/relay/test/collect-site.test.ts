import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { buildCatalog } from '../src/collect-site';

const demos = [
  { manifest: aManifest({ id: 'kafka', number: 2, title: 'Kafka' }), hasFeaturedTrace: true },
  { manifest: aManifest({ id: 'example', number: 0, publish: false }), hasFeaturedTrace: true },
  { manifest: aManifest({ id: 'aws-dms', number: 1, title: 'DMS' }), hasFeaturedTrace: false },
];

describe('buildCatalog', () => {
  it('lists published demos in number order', () => {
    expect(buildCatalog(demos, false).map((entry) => [entry.id, entry.hasReplay])).toEqual([
      ['aws-dms', false],
      ['kafka', true],
    ]);
  });

  it('includes unpublished demos only when asked', () => {
    expect(buildCatalog(demos, true).map((entry) => entry.id)).toEqual(['example', 'aws-dms', 'kafka']);
  });
});
