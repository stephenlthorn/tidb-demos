data "tidbcloud_dedicated_private_link_service" "this" {
  count         = var.connection_mode == "private" ? 1 : 0
  cluster_id    = tidbcloud_dedicated_cluster.this.cluster_id
  node_group_id = tidbcloud_dedicated_cluster.this.tidb_node_setting.node_group_id
}

resource "aws_security_group" "tidb_private_endpoint" {
  count       = var.connection_mode == "private" ? 1 : 0
  name        = "lab-terraform-eks-tidb-endpoint"
  description = "Allow EKS pods to reach the TiDB Cloud private endpoint on 4000"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 4000
    to_port     = 4000
    protocol    = "tcp"
    cidr_blocks = [module.vpc.vpc_cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Demo = "terraform-eks" }
}

# Exactly one VPC endpoint for PrivateLink: an Interface endpoint is billed
# per-AZ-hour ($0.01/AZ-hour, AWS PrivateLink pricing, checked 2026-09-28)
# plus data processing, so this demo creates only the one endpoint it needs
# rather than one per subnet/AZ pair. It is reachable from every subnet in
# this VPC (interface endpoints route within the VPC, not just within their
# own subnet), so it does not need to live in the same subnets as the
# worker nodes.
resource "aws_vpc_endpoint" "tidb" {
  count               = var.connection_mode == "private" ? 1 : 0
  vpc_id              = module.vpc.vpc_id
  service_name        = data.tidbcloud_dedicated_private_link_service.this[0].service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [module.vpc.public_subnets[0]]
  security_group_ids  = [aws_security_group.tidb_private_endpoint[0].id]
  private_dns_enabled = false

  tags = { Demo = "terraform-eks" }
}

resource "tidbcloud_dedicated_private_endpoint_connection" "this" {
  count         = var.connection_mode == "private" ? 1 : 0
  cluster_id    = tidbcloud_dedicated_cluster.this.cluster_id
  node_group_id = tidbcloud_dedicated_cluster.this.tidb_node_setting.node_group_id
  endpoint_id   = aws_vpc_endpoint.tidb[0].id
}
