export type EventType = 'purchase' | 'refund' | 'chargeback';

export type GeneratedEvent = {
  readonly customerId: number;
  readonly eventType: EventType;
  readonly amount: number;
};

export type RandomSource = () => number;

const weightedEventType = (random: RandomSource): EventType => {
  const roll = random();
  if (roll < 0.85) return 'purchase';
  if (roll < 0.97) return 'refund';
  return 'chargeback';
};

export const generateEvent = (customerCount: number, random: RandomSource): GeneratedEvent => {
  const customerId = 1 + Math.floor(random() * customerCount);
  const eventType = weightedEventType(random);
  const baseAmount = 5 + random() * 495;
  const amount = Math.round(baseAmount * 100) / 100;
  return { customerId, eventType, amount };
};
