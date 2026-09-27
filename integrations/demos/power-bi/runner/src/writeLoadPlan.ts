export type OrdersPerTickOptions = {
  readonly baseRatePerSec: number;
  readonly burstActive: boolean;
  readonly burstFactor: number;
};

export const ordersPerTick = (options: OrdersPerTickOptions): number => {
  const rate = options.burstActive ? options.baseRatePerSec * options.burstFactor : options.baseRatePerSec;
  return Math.max(1, Math.round(rate));
};
