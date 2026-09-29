variable "aws_region" {
  type        = string
  default     = "us-west-2"
  description = "AWS region for the VPC, EKS cluster, and the TiDB Cloud region this demo targets (TiDB Cloud Starter full-text search and this demo's Dedicated cluster are both available in us-west-2)"
}

variable "tidbcloud_public_key" {
  type      = string
  sensitive = true
}

variable "tidbcloud_private_key" {
  type      = string
  sensitive = true
}

variable "tidbcloud_project_id" {
  type        = string
  default     = ""
  description = "TiDB Cloud project id to create the cluster in; leave empty to use the default project. Look it up with infra/scripts/lookup-project-id.sh (reads TIDBCLOUD_PUBLIC_KEY/TIDBCLOUD_PRIVATE_KEY from ~/.config/tidb-lab/secrets.env)."
}

variable "tidbcloud_region_id" {
  type        = string
  default     = "aws-us-west-2"
  description = "TiDB Cloud region id for the Dedicated cluster; must be an AWS region id since the EKS side of this demo runs on AWS"
}

variable "tidb_root_password" {
  type      = string
  sensitive = true
}

variable "tidb_node_spec_key" {
  type        = string
  default     = "4C16G"
  description = "Smallest published TiDB Cloud Dedicated TiDB node spec on AWS as of 2026-09-28 (4 vCPU / 16 GiB, $0.4416/hr in us-west-2; see pingcap.com/tidb-dedicated-pricing-details). The provider's own example still shows the older 2C4G key; if 4C16G is rejected for this project/region, check the TiDB Cloud console's cluster-creation node-size picker for the current smallest key and use that instead."
}

variable "tikv_node_spec_key" {
  type        = string
  default     = "4C16G"
  description = "Smallest published TiDB Cloud Dedicated TiKV node spec on AWS as of 2026-09-28 (4 vCPU / 16 GiB, $0.4416/hr in us-west-2); see tidb_node_spec_key's description for the same caveat."
}

variable "tidb_node_count" {
  type        = number
  default     = 1
  description = "TiDB node count; the scale demo raises this to 2 in place (SCALE_TIDB_NODE_COUNT), which is the smallest possible scale-out and matches TiDB Cloud's own recommendation of at least 2 TiDB nodes for HA"
}

variable "tikv_node_count" {
  type        = number
  default     = 3
  description = "TiKV node count; 3 (one set across 3 availability zones) is TiDB Cloud Dedicated's hard minimum for TiKV, so this is never scaled by this demo"
}

variable "tikv_storage_size_gi" {
  type    = number
  # Confirmed live: TiDB Cloud Dedicated rejects a TiKV storage_size_gi
  # below 200 ("Storage_size_gib(10) of the node_type(tikv) is less than
  # the minimum size(200)."), so 200 is this demo's real floor, not 10.
  default = 200
}

variable "eks_node_desired_size" {
  type        = number
  default     = 2
  description = "Number of EKS managed-node-group worker nodes; kept to the 1-2 range this demo needs (2 by default so the app Deployment's 2 replicas can spread across nodes)"
}

variable "app_image" {
  type        = string
  description = "Container image reference for the demo app, pinned by digest. Build it multi-arch (linux/amd64,linux/arm64) since the node group runs arm64 (t4g.medium) instances."
}

variable "connection_mode" {
  type        = string
  default     = "private"
  description = "One of public_tls or private. Defaults to private because a PrivateLink connection is one of this demo's three acts (provision, connect privately, scale); public_tls remains available as a documented fallback, see README."
  validation {
    condition     = contains(["public_tls", "private"], var.connection_mode)
    error_message = "connection_mode must be public_tls or private"
  }
}
