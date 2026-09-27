export type Order = {
  readonly orderId: string;
  readonly region: string;
  readonly productCategory: string;
  readonly amount: number;
  readonly isHeartbeat: boolean;
};

export type RandomSource = () => number;

const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'] as const;
const CATEGORIES = ['electronics', 'home', 'outdoor', 'apparel'] as const;

export type CreateOrderOptions = {
  readonly sequence: number;
  readonly randomSource: RandomSource;
};

export const createOrder = (options: CreateOrderOptions): Order => {
  const regionIndex = Math.floor(options.randomSource() * REGIONS.length);
  const categoryIndex = Math.floor(options.randomSource() * CATEGORIES.length);
  const amount = Math.round((10 + options.randomSource() * 490) * 100) / 100;
  return {
    orderId: `ord-${options.sequence}`,
    region: REGIONS[regionIndex] ?? REGIONS[0],
    productCategory: CATEGORIES[categoryIndex] ?? CATEGORIES[0],
    amount,
    isHeartbeat: false,
  };
};

export type CreateHeartbeatOrderOptions = {
  readonly sequence: number;
};

export const createHeartbeatOrder = (options: CreateHeartbeatOrderOptions): Order => ({
  orderId: `hb-${options.sequence}`,
  region: 'us-east',
  productCategory: 'heartbeat',
  amount: 0,
  isHeartbeat: true,
});
