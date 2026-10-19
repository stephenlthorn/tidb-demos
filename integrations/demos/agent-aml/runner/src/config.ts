import { z } from 'zod';
import { REPORTING_THRESHOLD_CENTS } from './domain';

const requiredText = z.string().min(1);

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  AML_CLUSTER_ID: requiredText,
  S3_BUCKET: requiredText,
  S3_REGION: requiredText.default('us-east-1'),
  AWS_ACCESS_KEY_ID: requiredText,
  AWS_SECRET_ACCESS_KEY: requiredText,
  LAKE_WAREHOUSE: requiredText,
  AML_BRANCH_PASSWORD: z.string().default(''),
  AML_SEED: positiveInt(20261016),
  AML_HISTORY_DAYS: positiveInt(90),
  AML_RETAIL_COUNT: positiveInt(240),
  AML_BUSINESS_COUNT: positiveInt(40),
  AML_LOOK_ALIKE_COUNT: positiveInt(4),
  AML_BRANCH_COUNT: positiveInt(12),
  AML_TICK_MS: positiveInt(2000),
  AML_LOOKBACK_MONTHS: positiveInt(3),
  AML_REPORTING_THRESHOLD_CENTS: positiveInt(REPORTING_THRESHOLD_CENTS),
  AML_FIRST_DAY: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-01-05'),
  AML_RESET: z.enum(['true', 'false']).default('false'),
});

export type AmlConfig = {
  readonly clusterId: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly lakeWarehouse: string;
  readonly branchPassword: string;
  readonly seed: number;
  readonly historyDays: number;
  readonly retailCount: number;
  readonly businessCount: number;
  readonly lookAlikeCount: number;
  readonly branchCount: number;
  readonly tickMs: number;
  readonly lookbackMonths: number;
  readonly thresholdCents: number;
  readonly firstDayStartMs: number;
  readonly reset: boolean;
};

export const loadConfig = (env: Readonly<Record<string, string | undefined>>): AmlConfig => {
  const parsed = EnvSchema.parse(env);
  return {
    clusterId: parsed.AML_CLUSTER_ID,
    bucket: parsed.S3_BUCKET,
    region: parsed.S3_REGION,
    accessKeyId: parsed.AWS_ACCESS_KEY_ID,
    secretAccessKey: parsed.AWS_SECRET_ACCESS_KEY,
    lakeWarehouse: parsed.LAKE_WAREHOUSE,
    branchPassword: parsed.AML_BRANCH_PASSWORD,
    seed: parsed.AML_SEED,
    historyDays: parsed.AML_HISTORY_DAYS,
    retailCount: parsed.AML_RETAIL_COUNT,
    businessCount: parsed.AML_BUSINESS_COUNT,
    lookAlikeCount: parsed.AML_LOOK_ALIKE_COUNT,
    branchCount: parsed.AML_BRANCH_COUNT,
    tickMs: parsed.AML_TICK_MS,
    lookbackMonths: parsed.AML_LOOKBACK_MONTHS,
    thresholdCents: parsed.AML_REPORTING_THRESHOLD_CENTS,
    firstDayStartMs: Date.parse(`${parsed.AML_FIRST_DAY}T00:00:00Z`),
    reset: parsed.AML_RESET === 'true',
  };
};
