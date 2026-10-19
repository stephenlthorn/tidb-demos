import { describe, expect, it } from 'vitest';
import { pickReplayTarget, pickWinner, scoreAttempt } from '../src/score';

describe('scoreAttempt', () => {
  it('rewards small, short attempts that pass', () => {
    expect(scoreAttempt({ passed: true, changedFiles: 2, steps: 7 })).toBe(73);
    expect(scoreAttempt({ passed: true, changedFiles: 4, steps: 9 })).toBe(51);
  });

  it('scores a failed attempt zero', () => {
    expect(scoreAttempt({ passed: false, changedFiles: 1, steps: 3 })).toBe(0);
  });

  it('never goes below zero', () => {
    expect(scoreAttempt({ passed: true, changedFiles: 20, steps: 40 })).toBe(0);
  });
});

describe('pickWinner', () => {
  const results = [
    { attemptId: 'attempt-1', passed: true, changedFiles: 2, steps: 7 },
    { attemptId: 'attempt-2', passed: false, changedFiles: 2, steps: 7 },
    { attemptId: 'attempt-3', passed: true, changedFiles: 4, steps: 9 },
  ];

  it('picks the highest scoring attempt that passed', () => {
    expect(pickWinner(results)?.attemptId).toBe('attempt-1');
  });

  it('lets a lower scoring attempt win when the better one failed', () => {
    const failedFirst = results.map((result) => (result.attemptId === 'attempt-1' ? { ...result, passed: false } : result));
    expect(pickWinner(failedFirst)?.attemptId).toBe('attempt-3');
  });

  it('breaks ties by attempt id', () => {
    expect(
      pickWinner([
        { attemptId: 'attempt-2', passed: true, changedFiles: 1, steps: 1 },
        { attemptId: 'attempt-1', passed: true, changedFiles: 1, steps: 1 },
      ])?.attemptId,
    ).toBe('attempt-1');
  });

  it('returns nothing when no attempt passed', () => {
    expect(pickWinner(results.map((result) => ({ ...result, passed: false })))).toBeUndefined();
  });
});

describe('pickReplayTarget', () => {
  it('chooses the attempt that got furthest before it halted', () => {
    expect(
      pickReplayTarget([
        { attemptId: 'attempt-1', haltedAtStep: 5 },
        { attemptId: 'attempt-2', haltedAtStep: 7 },
      ]),
    ).toEqual({ attemptId: 'attempt-2', haltedAtStep: 7 });
  });

  it('returns nothing when no attempt halted', () => {
    expect(pickReplayTarget([])).toBeUndefined();
  });
});
