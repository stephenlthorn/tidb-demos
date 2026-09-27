module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.26"

  name               = "lab-terraform-eks"
  kubernetes_version = "1.33"

  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  addons = {
    coredns                = {}
    eks-pod-identity-agent = { before_compute = true }
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = ["m5.large"]
      min_size       = 1
      max_size       = 4
      desired_size   = var.eks_node_desired_size
    }
  }

  tags = {
    Demo = "terraform-eks"
  }
}
