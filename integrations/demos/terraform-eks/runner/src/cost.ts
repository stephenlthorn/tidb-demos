export type CostInputs = {
  readonly eksControlPlaneUsdHr: number;
  readonly ec2NodeUsdHr: number;
  readonly ec2NodeCount: number;
  readonly natGatewayUsdHr: number;
  readonly natGatewayCount: number;
  readonly tidbNodeUsdHr: number;
  readonly tidbNodeCount: number;
  readonly tikvNodeUsdHr: number;
  readonly tikvNodeCount: number;
};

export const estimateHourlyCostUsd = (inputs: CostInputs): number =>
  inputs.eksControlPlaneUsdHr +
  inputs.ec2NodeUsdHr * inputs.ec2NodeCount +
  inputs.natGatewayUsdHr * inputs.natGatewayCount +
  inputs.tidbNodeUsdHr * inputs.tidbNodeCount +
  inputs.tikvNodeUsdHr * inputs.tikvNodeCount;
