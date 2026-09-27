variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "tidbcloud_public_key" {
  type      = string
  sensitive = true
}

variable "tidbcloud_private_key" {
  type      = string
  sensitive = true
}

variable "tidbcloud_region_id" {
  type        = string
  description = "TiDB Cloud region id for the Dedicated cluster, e.g. aws-us-east-1"
}

variable "tidb_root_password" {
  type      = string
  sensitive = true
}

variable "tidb_node_count" {
  type    = number
  default = 1
}

variable "tikv_node_count" {
  type    = number
  default = 3
}

variable "tikv_storage_size_gi" {
  type    = number
  default = 10
}

variable "eks_node_desired_size" {
  type    = number
  default = 2
}

variable "app_image" {
  type        = string
  description = "Container image reference for the demo app, pinned by digest"
}

variable "connection_mode" {
  type        = string
  default     = "public_tls"
  description = "One of public_tls or private; see README for the tradeoff"
  validation {
    condition     = contains(["public_tls", "private"], var.connection_mode)
    error_message = "connection_mode must be public_tls or private"
  }
}
