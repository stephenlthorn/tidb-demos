const RESOURCE_TYPE_TO_NODE: Readonly<Record<string, string>> = {
  aws_vpc: 'aws-vpc',
  aws_subnet: 'aws-vpc',
  aws_nat_gateway: 'aws-vpc',
  aws_internet_gateway: 'aws-vpc',
  aws_route_table: 'aws-vpc',
  aws_eip: 'aws-vpc',
  aws_eks_cluster: 'eks-cluster',
  aws_eks_node_group: 'eks-cluster',
  aws_iam_role: 'eks-cluster',
  aws_iam_role_policy_attachment: 'eks-cluster',
  kubernetes_deployment_v1: 'app-deployment',
  kubernetes_service_v1: 'app-deployment',
  kubernetes_secret_v1: 'app-deployment',
  tidbcloud_dedicated_cluster: 'tidb-cluster',
  tidbcloud_dedicated_network_container: 'tidb-cluster',
  tidbcloud_dedicated_private_endpoint_connection: 'private-endpoint',
  aws_vpc_endpoint: 'private-endpoint',
  aws_security_group: 'private-endpoint',
};

export const nodeIdForResourceType = (resourceType: string): string | undefined =>
  RESOURCE_TYPE_TO_NODE[resourceType];
