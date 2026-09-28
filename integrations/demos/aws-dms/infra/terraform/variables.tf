variable "aws_region" {
  description = "AWS region for all resources in this demo. Must match the TiDB Cloud Starter cluster's region (us-west-2 for full-text search availability)."
  type        = string
  default     = "us-west-2"
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

variable "public_subnet_cidrs" {
  description = "CIDR blocks for the two public subnets that hold both the DMS replication instance and Aurora. Both are publicly_accessible: DMS needs to reach TiDB Cloud Starter's public endpoint, and Aurora needs to be reachable from the coordinator's Mac, which runs the demo's runner and has no bastion/VPN path into this VPC. This avoids paying for a NAT gateway (Section 4/5 of the plan explains this tradeoff). Two subnets in two AZs because the DMS replication subnet group and Aurora's DB subnet group both require at least two AZs."
  type        = list(string)
  default     = ["10.42.0.0/24", "10.42.3.0/24"]
}

variable "admin_cidr" {
  description = "CIDR allowed to reach Aurora on port 5432 directly, in addition to the DMS security group. This is the demo runner's workstation public IP as a /32 (the coordinator's Mac), since this demo has no bastion or VPN and the runner needs a direct connection for writes, checksums, and cutover. Pass at apply time, e.g. -var admin_cidr=$(curl -s https://checkip.amazonaws.com)/32. No default: an open CIDR here would expose Aurora's port to the internet, so this must be set explicitly."
  type        = string
}

variable "availability_zones" {
  description = "Two AZs in aws_region; Aurora's DB subnet group and the DMS replication subnet group both need >= 2 AZs."
  type        = list(string)
  default     = ["us-west-2a", "us-west-2b"]
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL engine version. Must be >= 2.2 (PostgreSQL 10.6-compatible) for CDC support, and must be a version Aurora Serverless v2 supports (Section 4)."
  type        = string
  default     = "15.4"
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

variable "aurora_min_acu" {
  description = "Aurora Serverless v2 minimum capacity, in Aurora Capacity Units (ACUs, 2 GiB memory each). 0.5 is the documented minimum and is the cheapest floor that keeps the writer warm for this demo's ~2 hour run; a provisioned db.t4g.medium instance was considered instead but bills its full hourly rate for the whole run even while idle during provisioning/schema-conversion phases, so Serverless v2 at its floor is cheaper here (Section 5)."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  description = "Aurora Serverless v2 maximum capacity, in ACUs. 2 ACUs (4 GiB) is enough headroom for the load generator's burst-writes control without materially changing the cost of a short demo run."
  type        = number
  default     = 2
}

variable "dms_instance_class" {
  description = "DMS replication instance class. dms.t3.small (2 vCPU / 2 GiB) is the smallest class this demo uses: dms.t3.micro (1 GiB) risks the OOM failure mode AWS and PingCAP both document for full-load-and-cdc tasks, even though this demo's schema and data volume are modest and short-lived (Section 4/5). dms.t3.large remains the recommendation for production migrations."
  type        = string
  default     = "dms.t3.small"
}

variable "dms_allocated_storage_gb" {
  description = "Storage for the DMS replication instance, in GB. 20 GB is enough for this demo's small schema and short CDC window; DMS storage bills by GB-month so a smaller allocation modestly reduces cost."
  type        = number
  default     = 20
}

variable "tidb_host" {
  description = "TiDB Cloud Starter cluster's public endpoint host, created out of band by the tidbcloud-starter module and written into demos/aws-dms/.env as TIDB_HOST. Pass to Terraform as TF_VAR_tidb_host or via a gitignored .tfvars file generated from .env; never commit a literal value."
  type        = string
}

variable "tidb_port" {
  type    = number
  default = 4000
}

variable "tidb_user" {
  description = "TiDB Cloud Starter database user for the DMS target endpoint. Written into demos/aws-dms/.env as TIDB_USER by the tidbcloud-starter module. Needs GRANT ALTER, CREATE, DROP, INDEX, INSERT, UPDATE, DELETE, SELECT, CREATE TEMPORARY TABLES ON <schema>.* plus GRANT ALL PRIVILEGES ON awsdms_control.* (Section 4)."
  type        = string
}

variable "tidb_password" {
  description = "TiDB Cloud Starter database password for the DMS target endpoint. Pass via TF_VAR_tidb_password or a gitignored .tfvars file generated from .env; never commit a literal value."
  type        = string
  sensitive   = true
}
