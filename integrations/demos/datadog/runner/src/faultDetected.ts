export type FaultId = 'slow-query-storm' | 'write-hot-spot' | 'store-outage' | 'connection-surge';

export type IsFaultDetectedOptions = {
  readonly fault: FaultId;
  readonly overallState: string;
};

export const isFaultDetected = ({ fault, overallState }: IsFaultDetectedOptions): boolean => {
  if (overallState === 'Alert') return true;
  if (fault === 'store-outage' && overallState === 'No Data') return true;
  return false;
};
