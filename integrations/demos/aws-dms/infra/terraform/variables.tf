variable "aws_region" {
  description = "AWS region for all resources in this demo. Must match the TiDB Cloud Dedicated cluster's region."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to every resource name created by this demo, to make teardown and cost attribution unambiguous."
  type        = string
  default     = "tidb-lab-aws-dms"
}

variable "vpc_cidr" {
  description = "CIDR block for the demo VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for the two private subnets (Aurora + DMS replication instance)."
  type        = list(string)
  default     = ["10.42.1.0/24", "10.42.2.0/24"]
}

variable "public_subnet_cidr" {
  description = "CIDR block for the single public subnet (NAT gateway only; nothing in this demo is publicly reachable)."
  type        = string
  default     = "10.42.0.0/24"
}

variable "availability_zones" {
  description = "Two AZs in aws_region; Aurora and the DMS subnet group both need >= 2 AZs."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL engine version. Must be >= 2.2 (PostgreSQL 10.6-compatible) for CDC support (Section 4)."
  type        = string
  default     = "15.4"
}

variable "aurora_instance_class" {
  description = "Instance class for the single Aurora writer instance. db.t4g.medium is the smallest class this demo has validated for logical-replication CDC without falling behind under the demo's load profile."
  type        = string
  default     = "db.t4g.medium"
}

variable "aurora_master_username" {
  type    = string
  default = "labadmin"
}

variable "aurora_master_password" {
  description = "Master password for the Aurora cluster. Pass via TF_VAR_aurora_master_password or a .tfvars file that is gitignored; never commit a literal value."
  type        = string
  sensitive   = true
}

variable "aurora_database_name" {
  type    = string
  default = "lab"
}

variable "dms_instance_class" {
  description = "DMS replication instance class. dms.t3.large (2 vCPU / 8 GiB) is the minimum PingCAP recommends to avoid OOM during full load (Section 4)."
  type        = string
  default     = "dms.t3.large"
}

variable "dms_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "tidb_host" {
  description = "TiDB Cloud Dedicated cluster host, created out of band per Task 2's manual step. Used only to compute the security group egress rule and is not itself provisioned by Terraform."
  type        = string
}

variable "tidb_port" {
  type    = number
  default = 4000
}

variable "tidb_traffic_filter_cidr" {
  description = "CIDR to add to the TiDB Cloud Dedicated cluster's traffic filter, computed from this VPC's private subnets and passed to the manual traffic-filter step in the README; not applied by Terraform (TiDB Cloud Terraform provider is optional, see the note below the outputs)."
  type        = string
  default     = null
}
