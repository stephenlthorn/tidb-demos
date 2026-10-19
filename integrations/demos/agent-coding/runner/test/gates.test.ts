import { describe, expect, it } from 'vitest';
import { assertBranchHeadroom, gateControl } from '../src/gates';

describe('gateControl', () => {
  it('lets fan-out run once', () => {
    expect(gateControl({ control: 'fan-out', done: [] })).toEqual({ run: true });
    expect(gateControl({ control: 'fan-out', done: ['fan-out'] })).toMatchObject({ run: false });
  });

  it('only arms the flaky dependency before the fan-out', () => {
    expect(gateControl({ control: 'inject-flaky-dependency', done: [] })).toEqual({ run: true });
    expect(gateControl({ control: 'inject-flaky-dependency', done: ['fan-out'] })).toMatchObject({ run: false });
  });

  it('needs the fan-out before a replay or an eval', () => {
    expect(gateControl({ control: 'replay-failed-step', done: [] })).toEqual({ run: false, reason: 'press fan-out first' });
    expect(gateControl({ control: 'run-eval', done: [] })).toEqual({ run: false, reason: 'press fan-out first' });
    expect(gateControl({ control: 'replay-failed-step', done: ['fan-out'] })).toEqual({ run: true });
    expect(gateControl({ control: 'run-eval', done: ['fan-out'] })).toEqual({ run: true });
  });

  it('writes the lesson only after both the replay and the eval', () => {
    expect(gateControl({ control: 'write-lesson', done: ['fan-out', 'run-eval'] })).toEqual({
      run: false,
      reason: 'replay the failed step first',
    });
    expect(gateControl({ control: 'write-lesson', done: ['fan-out', 'replay-failed-step'] })).toEqual({
      run: false,
      reason: 'run the eval first',
    });
    expect(gateControl({ control: 'write-lesson', done: ['fan-out', 'replay-failed-step', 'run-eval'] })).toEqual({
      run: true,
    });
  });

  it('refuses a second lesson and an unknown control', () => {
    expect(
      gateControl({ control: 'write-lesson', done: ['fan-out', 'replay-failed-step', 'run-eval', 'write-lesson'] }),
    ).toMatchObject({ run: false });
    expect(gateControl({ control: 'nope', done: [] })).toEqual({ run: false, reason: 'unknown control: nope' });
  });
});

describe('assertBranchHeadroom', () => {
  it('accepts a plan that fits the quota', () => {
    expect(() => assertBranchHeadroom({ existing: 1, needed: 4, quota: 5 })).not.toThrow();
  });

  it('names the numbers when it does not fit', () => {
    expect(() => assertBranchHeadroom({ existing: 2, needed: 4, quota: 5 })).toThrow(
      'branch quota exceeded: 2 existing + 4 needed is more than 5',
    );
  });
});
