import { describe, expect, it } from 'vitest';
import { estimateHourlyCostUsd } from './cost';

const baseInputs = {
  eksControlPlaneUsdHr: 0.1,
  ec2NodeUsdHr: 0.2,
  ec2NodeCount: 3,
  natGatewayUsdHr: 0.045,
  natGatewayCount: 1,
  vpcEndpointUsdHr: 0.01,
  vpcEndpointCount: 1,
  tidbNodeUsdHr: 0.3,
  tidbNodeCount: 2,
  tikvNodeUsdHr: 0.5,
  tikvNodeCount: 3,
};

describe('estimateHourlyCostUsd', () => {
  it('sums control plane, node, NAT, VPC endpoint, and TiDB node costs', () => {
    const total = estimateHourlyCostUsd(baseInputs);
    expect(total).toBeCloseTo(0.1 + 0.2 * 3 + 0.045 * 1 + 0.01 * 1 + 0.3 * 2 + 0.5 * 3, 5);
  });

  it('returns 0 when every count is 0 and every price is 0', () => {
    const total = estimateHourlyCostUsd({
      eksControlPlaneUsdHr: 0,
      ec2NodeUsdHr: 0,
      ec2NodeCount: 0,
      natGatewayUsdHr: 0,
      natGatewayCount: 0,
      vpcEndpointUsdHr: 0,
      vpcEndpointCount: 0,
      tidbNodeUsdHr: 0,
      tidbNodeCount: 0,
      tikvNodeUsdHr: 0,
      tikvNodeCount: 0,
    });
    expect(total).toBe(0);
  });

  it('reflects a tikv node count increase from a scale change', () => {
    const before = estimateHourlyCostUsd(baseInputs);
    const after = estimateHourlyCostUsd({ ...baseInputs, tikvNodeCount: 5 });
    expect(after).toBeCloseTo(before + 0.5 * 2, 5);
  });

  it('reflects a tidb node count increase from this demo\'s scale-out (1 -> 2)', () => {
    const before = estimateHourlyCostUsd({ ...baseInputs, tidbNodeCount: 1 });
    const after = estimateHourlyCostUsd({ ...baseInputs, tidbNodeCount: 2 });
    expect(after).toBeCloseTo(before + 0.3, 5);
  });

  it('omits the NAT gateway cost when this demo runs with no NAT gateway', () => {
    const total = estimateHourlyCostUsd({ ...baseInputs, natGatewayUsdHr: 0.045, natGatewayCount: 0 });
    expect(total).toBeCloseTo(0.1 + 0.2 * 3 + 0.01 * 1 + 0.3 * 2 + 0.5 * 3, 5);
  });
});
