terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.2"
    }
    tidbcloud = {
      source  = "tidbcloud/tidbcloud"
      version = "~> 0.4"
    }
  }
}

provider "aws" {
  region = var.aws_region
  # Every AWS resource this demo creates (directly, or via the vpc/eks
  # modules) is tagged through this single default_tags block so a cost
  # sweep can find and remove anything left running, without having to
  # repeat tags on every resource. Set AWS_PROFILE in the
  # environment before running terraform; the provider reads it from the
  # standard AWS credential chain rather than a hardcoded profile argument.
  default_tags {
    tags = {
      Project = "tidb-integration-lab"
      Demo    = "terraform-eks"
    }
  }
}

provider "tidbcloud" {
  public_key  = var.tidbcloud_public_key
  private_key = var.tidbcloud_private_key
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.aws_region]
  }
}
