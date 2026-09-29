import { describe, expect, it } from 'vitest';
import { CatalogSchema } from '../src/index';

const baseEntry = { id: 'kafka', number: 2, title: 'Kafka', tagline: 't', integrations: ['Kafka'], hasReplay: false };

describe('CatalogSchema media', () => {
  it('accepts an entry with no media', () => {
    expect(CatalogSchema.safeParse([baseEntry]).success).toBe(true);
  });

  it('accepts an entry with videos and screenshots', () => {
    const entry = {
      ...baseEntry,
      media: {
        videos: [{ src: 'data/media/kafka/kafka-live.mp4', title: 'Live' }],
        screenshots: [
          { src: 'data/media/kafka/screenshots/01-start.jpg', caption: 'Start', group: 'console' },
          { src: 'data/media/kafka/replay/02-phase-warmup.jpg', caption: 'Phase: warmup', group: 'replay' },
        ],
      },
    };
    expect(CatalogSchema.safeParse([entry]).success).toBe(true);
  });

  it('rejects an unknown screenshot group', () => {
    const entry = {
      ...baseEntry,
      media: {
        videos: [],
        screenshots: [{ src: 'x.jpg', caption: 'c', group: 'nope' }],
      },
    };
    expect(CatalogSchema.safeParse([entry]).success).toBe(false);
  });
});
