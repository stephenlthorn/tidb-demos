import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifestInput } from '@lab/contract/testing';
import { useLive } from '../src/sources/use-live';

const deferred = <T,>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } => {
  const holder: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    holder.resolve = resolve;
  });
  return { promise, resolve: (value) => holder.resolve?.(value) };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useLive', () => {
  it('does not open an event stream when unmounted before the manifest arrives', async () => {
    const response = deferred<Response>();
    const opened: string[] = [];
    vi.stubGlobal('fetch', () => response.promise);
    vi.stubGlobal(
      'EventSource',
      class {
        constructor(url: string) {
          opened.push(url);
        }
        close(): void {
          opened.push('closed');
        }
      },
    );
    const { unmount } = renderHook(() => useLive('http://localhost:7070'));
    unmount();
    response.resolve(new Response(JSON.stringify(manifestInput())));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toEqual([]);
  });
});
