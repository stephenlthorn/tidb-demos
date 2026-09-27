export type ScoringRuleName = 'velocity' | 'amount';

export type ScoringRule = {
  readonly name: ScoringRuleName;
  readonly windowMinutes: number;
  readonly chargebackWeight: number;
  readonly refundWeight: number;
  readonly baseWeight: number;
};

export const velocityRule: ScoringRule = {
  name: 'velocity',
  windowMinutes: 5,
  chargebackWeight: 4,
  refundWeight: 2,
  baseWeight: 1,
};

export const amountRule: ScoringRule = {
  name: 'amount',
  windowMinutes: 15,
  chargebackWeight: 1.5,
  refundWeight: 1.2,
  baseWeight: 1,
};

export const nextRule = (current: ScoringRule): ScoringRule =>
  (current.name === 'velocity' ? amountRule : velocityRule);
