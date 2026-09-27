import { describe, expect, it } from 'vitest';
import { downsample, seriesPath } from '../src/charts/path';
import { CANVAS, edgePath, midpoint, particleSpec, toCanvas } from '../src/diagram/geometry';

describe('diagram geometry', () => {
  it('maps percentage coordinates onto the canvas', () => {
    expect(toCanvas({ id: 'a', label: 'A', kind: 'tidb', x: 50, y: 50 })).toEqual({ x: CANVAS.width / 2, y: CANVAS.height / 2 });
  });

  it('draws a horizontal-tangent cubic between two points', () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 100, y: 50 })).toBe('M 0 0 C 50 0, 50 50, 100 50');
    expect(midpoint({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 25 });
  });

  it('shows no particles when idle and more, faster particles as rate grows, capped at 12', () => {
    expect(particleSpec(0)).toEqual({ count: 0, durationS: 0 });
    const slow = particleSpec(10);
    const fast = particleSpec(10000);
    expect(fast.count).toBeGreaterThan(slow.count);
    expect(fast.durationS).toBeLessThan(slow.durationS);
    expect(particleSpec(1e12).count).toBe(12);
  });
});

describe('chart paths', () => {
  it('returns an empty path for fewer than two points', () => {
    expect(seriesPath([{ t: 0, value: 1 }], { width: 100, height: 20 })).toBe('');
  });

  it('scales points into the box with higher values drawn higher', () => {
    expect(seriesPath([{ t: 0, value: 0 }, { t: 10, value: 10 }], { width: 100, height: 20 })).toBe('M 0.0 20.0 L 100.0 0.0');
  });

  it('downsamples by keeping the max of each bucket', () => {
    const points = [1, 9, 2, 3, 8, 4].map((value, t) => ({ t, value }));
    expect(downsample(points, 3).map((point) => point.value)).toEqual([9, 3, 8]);
    expect(downsample(points, 10)).toBe(points);
  });
});
