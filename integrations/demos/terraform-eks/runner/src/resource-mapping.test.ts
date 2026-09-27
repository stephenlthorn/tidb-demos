import { describe, expect, it } from 'vitest';
import { nodeIdForResourceType } from './resource-mapping';

describe('nodeIdForResourceType', () => {
  it('maps the tidbcloud dedicated cluster resource to the tidb-cluster node', () => {
    expect(nodeIdForResourceType('tidbcloud_dedicated_cluster')).toBe('tidb-cluster');
  });

  it('maps the tidbcloud private endpoint connection resource to the private-endpoint node', () => {
    expect(nodeIdForResourceType('tidbcloud_dedicated_private_endpoint_connection')).toBe('private-endpoint');
  });

  it('maps aws_vpc_endpoint to the private-endpoint node', () => {
    expect(nodeIdForResourceType('aws_vpc_endpoint')).toBe('private-endpoint');
  });

  it('maps module.vpc resource types to the aws-vpc node', () => {
    expect(nodeIdForResourceType('aws_vpc')).toBe('aws-vpc');
    expect(nodeIdForResourceType('aws_nat_gateway')).toBe('aws-vpc');
    expect(nodeIdForResourceType('aws_subnet')).toBe('aws-vpc');
  });

  it('maps module.eks resource types to the eks-cluster node', () => {
    expect(nodeIdForResourceType('aws_eks_cluster')).toBe('eks-cluster');
    expect(nodeIdForResourceType('aws_eks_node_group')).toBe('eks-cluster');
  });

  it('maps kubernetes_deployment_v1 to the app-deployment node', () => {
    expect(nodeIdForResourceType('kubernetes_deployment_v1')).toBe('app-deployment');
    expect(nodeIdForResourceType('kubernetes_service_v1')).toBe('app-deployment');
  });

  it('returns undefined for an unmapped resource type instead of guessing', () => {
    expect(nodeIdForResourceType('random_pet')).toBeUndefined();
  });
});
