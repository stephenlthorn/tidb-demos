import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Trace } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { useReplay } from '../src/sources/use-replay';

const trace: Trace = {
  schemaVersion: 1,
  manifest: aManifest(),
  recordedAt: '2026-09-25T15:00:00.000Z',
  environment: { tidb: 'tiup playground', components: {}, notes: '' },
  durationMs: 60000,
  events: [{ type: 'phase', t: 0, phase: 'warmup' }],
};

const stubFrames = (): { readonly fire: (now: number) => void } => {
  const pending: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pending.push(callback);
    return pending.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.spyOn(performance, 'now').mockReturnValue(0);
  return {
    fire: (now) => {
      const callbacks = pending.splice(0, pending.length);
      callbacks.forEach((callback) => callback(now));
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useReplay', () => {
  it('advances by the wall time between frames even when React defers the updates', () => {
    const frames = stubFrames();
    const { result } = renderHook(() => useReplay(trace));
    act(() => result.current.toggle());
    act(() => {
      frames.fire(1000);
      frames.fire(2000);
      frames.fire(3000);
    });
    expect(result.current.player.positionMs).toBe(3000);
  });

  it('starts paused at the given initial position', () => {
    const { result } = renderHook(() => useReplay(trace, 15000));
    expect(result.current.player.positionMs).toBe(15000);
    expect(result.current.player.playing).toBe(false);
  });

  it('clamps the initial position to the trace duration', () => {
    const { result } = renderHook(() => useReplay(trace, 999999));
    expect(result.current.player.positionMs).toBe(60000);
  });
});
