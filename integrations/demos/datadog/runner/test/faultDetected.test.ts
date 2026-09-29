import { describe, expect, it } from 'vitest';
import { isFaultDetected } from '../src/faultDetected';

describe('isFaultDetected', () => {
  it('treats overall_state Alert as detected for a threshold-based fault', () => {
    expect(isFaultDetected({ fault: 'slow-query-storm', overallState: 'Alert' })).toBe(true);
  });

  it('does not treat overall_state OK as detected', () => {
    expect(isFaultDetected({ fault: 'slow-query-storm', overallState: 'OK' })).toBe(false);
  });

  it('treats overall_state No Data as detected for the store-outage no-data monitor', () => {
    expect(isFaultDetected({ fault: 'store-outage', overallState: 'No Data' })).toBe(true);
  });

  it('does not treat overall_state No Data as detected for a threshold-based fault', () => {
    expect(isFaultDetected({ fault: 'connection-surge', overallState: 'No Data' })).toBe(false);
  });
});
