module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.26"

  name               = "lab-terraform-eks"
  kubernetes_version = "1.33"

  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.public_subnets

  addons = {
    coredns                = {}
    eks-pod-identity-agent = { before_compute = true }
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
  }

  eks_managed_node_groups = {
    default = {
      # arm64 (Graviton, t4g.medium) is the smallest viable managed node
      # here: at $0.0336/hr it is about 20% cheaper than the x86 t3.medium
      # equivalent, and the demo app is a dependency-free Go binary built
      # with go-sql-driver/mysql (pure Go, no cgo), so it cross-compiles to
      # linux/arm64 without any code change; see infra/app/Dockerfile.
      ami_type       = "AL2023_ARM_64_STANDARD"
      instance_types = ["t4g.medium"]
      min_size       = 1
      max_size       = 2
      desired_size   = var.eks_node_desired_size
    }
  }

  tags = {
    Demo = "terraform-eks"
  }
}
