import { describe, expect, it } from 'vitest';
import { velocityRule, amountRule, nextRule } from '../src/scoringRule';

describe('nextRule', () => {
  it('toggles from velocity to amount', () => {
    expect(nextRule(velocityRule)).toEqual(amountRule);
  });

  it('toggles from amount back to velocity', () => {
    expect(nextRule(amountRule)).toEqual(velocityRule);
  });

  it('round-trips back to the same rule after two toggles', () => {
    expect(nextRule(nextRule(velocityRule))).toEqual(velocityRule);
  });
});
