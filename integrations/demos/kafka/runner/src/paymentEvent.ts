import { z } from 'zod';

export type PaymentEvent = {
  readonly paymentId: string;
  readonly accountId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly produceTs: number;
};

export type CreatePaymentEventOptions = {
  readonly sequence: number;
  readonly now: () => number;
};

const padSequence = (sequence: number): string => String(sequence).padStart(6, '0');

const pseudoRandomAmountCents = (sequence: number): number => {
  const base = ((sequence * 7919) % 250000) + 100;
  return base;
};

const pseudoRandomAccountId = (sequence: number): string => `acct-${(sequence * 31) % 500}`;

export const createPaymentEvent = (options: CreatePaymentEventOptions): PaymentEvent => ({
  paymentId: `payment-${padSequence(options.sequence)}`,
  accountId: pseudoRandomAccountId(options.sequence),
  amountCents: pseudoRandomAmountCents(options.sequence),
  currency: 'USD',
  produceTs: options.now(),
});

export const encodePaymentEvent = (event: PaymentEvent): string => JSON.stringify(event);

const PaymentEventSchema = z.object({
  paymentId: z.string(),
  accountId: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  produceTs: z.number(),
});

export const decodePaymentEvent = (raw: string): PaymentEvent => PaymentEventSchema.parse(JSON.parse(raw));
