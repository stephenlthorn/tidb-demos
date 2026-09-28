import { describe, expect, it } from 'vitest';
import { createCutoverStateMachine } from '../runner/src/cutover-state';

describe('createCutoverStateMachine', () => {
  it('starts in the running state', () => {
    const machine = createCutoverStateMachine();
    expect(machine.getState()).toBe('running');
  });

  it('advances running -> draining -> verified -> flipped in order', () => {
    const machine = createCutoverStateMachine();
    expect(machine.beginDraining()).toEqual({ ok: true, state: 'draining' });
    expect(machine.markVerified()).toEqual({ ok: true, state: 'verified' });
    expect(machine.markFlipped()).toEqual({ ok: true, state: 'flipped' });
    expect(machine.getState()).toBe('flipped');
  });

  it('rejects markVerified before beginDraining', () => {
    const machine = createCutoverStateMachine();
    expect(machine.markVerified()).toEqual({
      ok: false,
      state: 'running',
      reason: 'cannot markVerified from running, expected draining',
    });
  });

  it('rejects markFlipped before markVerified', () => {
    const machine = createCutoverStateMachine();
    machine.beginDraining();
    expect(machine.markFlipped()).toEqual({
      ok: false,
      state: 'draining',
      reason: 'cannot markFlipped from draining, expected verified',
    });
  });

  it('rejects a second beginDraining once already draining', () => {
    const machine = createCutoverStateMachine();
    machine.beginDraining();
    expect(machine.beginDraining()).toEqual({
      ok: false,
      state: 'draining',
      reason: 'cannot beginDraining from draining, expected running',
    });
  });

  it('rejects any transition once flipped (terminal state)', () => {
    const machine = createCutoverStateMachine();
    machine.beginDraining();
    machine.markVerified();
    machine.markFlipped();
    expect(machine.beginDraining()).toEqual({
      ok: false,
      state: 'flipped',
      reason: 'cannot beginDraining from flipped, expected running',
    });
  });
});
