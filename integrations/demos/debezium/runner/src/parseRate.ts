export type ParseRateTracker = {
  readonly recordSuccess: () => void;
  readonly recordFailure: () => void;
  readonly successRatePercent: () => number;
};

export const createParseRateTracker = (): ParseRateTracker => {
  let successCount = 0;
  let totalCount = 0;
  return {
    recordSuccess: () => {
      successCount += 1;
      totalCount += 1;
    },
    recordFailure: () => {
      totalCount += 1;
    },
    successRatePercent: () => (totalCount === 0 ? 100 : (successCount / totalCount) * 100),
  };
};
