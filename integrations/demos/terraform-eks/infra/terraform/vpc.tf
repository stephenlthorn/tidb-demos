module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.7"

  name = "lab-terraform-eks"
  cidr = "10.60.0.0/16"

  azs            = ["${var.aws_region}a", "${var.aws_region}b"]
  public_subnets = ["10.60.101.0/24", "10.60.102.0/24"]

  # Public-only VPC, no NAT gateway: EKS worker nodes run in these public
  # subnets with public IPs (map_public_ip_on_launch) so they can pull
  # container images and reach the EKS API without a NAT gateway. This demo
  # is a short-lived recording session, not a production cluster, so the
  # tradeoff (worker nodes reachable at a public IP, locked down by the EKS
  # module's own security group to only cluster/control-plane traffic) is
  # worth avoiding a NAT gateway's $0.045/hr plus per-GB data processing.
  # The TiDB Cloud connection still goes over the private PrivateLink
  # endpoint below regardless of this choice.
  enable_nat_gateway      = false
  map_public_ip_on_launch = true

  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Demo = "terraform-eks"
  }
}
