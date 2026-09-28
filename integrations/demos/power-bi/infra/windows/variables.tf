variable "aws_region" {
  description = "AWS region for the Windows recording box. Must be a region TiDB Cloud Starter's public endpoint is reachable from (any region works; us-west-2 is used elsewhere in this lab for TiDB Cloud Starter full-text search availability)."
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "AWS CLI/SDK profile to use. Null means the AWS_PROFILE environment variable (set in ~/.config/tidb-lab/secrets.env)."
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Prefix applied to every resource name created by this demo, to make teardown and cost attribution unambiguous."
  type        = string
  default     = "tidb-lab-power-bi"
}

variable "admin_cidr" {
  description = "CIDR allowed to reach RDP (3389) on the Windows instance, e.g. the operator's current public IP as a /32 (\"203.0.113.5/32\"). Never widen this past a single operator's address."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for the Power BI Desktop box. t3.large (2 vCPU / 8 GiB) is the smallest burstable size that keeps Windows Server 2022's Desktop Experience plus Power BI Desktop's Chromium-based UI responsive over RDP; t3.medium's 4 GiB risks paging under the OS alone, before Power BI even opens a report."
  type        = string
  default     = "t3.large"
}

variable "root_volume_size_gb" {
  description = "Root (C:) volume size in GB. Windows Server 2022 plus Power BI Desktop and the MySQL Connector/NET package need roughly 30 GB; 60 GB leaves headroom for Windows Update and page file growth."
  type        = number
  default     = 60
}

variable "power_bi_installer_url" {
  description = "Direct download URL for the Power BI Desktop x64 installer (PBIDesktopSetup_x64.exe). Version-specific GUID in the path; re-check https://www.microsoft.com/en-us/download/details.aspx?id=58494 for the current URL before applying, since Microsoft rotates this per release."
  type        = string
  default     = "https://download.microsoft.com/download/8/8/0/880bca75-79dd-466a-927d-1abf1f5454b0/PBIDesktopSetup_x64.exe"
}

variable "mysql_connector_net_url" {
  description = "Direct download URL for the MySQL Connector/NET MSI, required by Power BI's MySQL database connector. Version-specific; re-check https://dev.mysql.com/downloads/connector/net/ for the current URL before applying."
  type        = string
  default     = "https://dev.mysql.com/get/Downloads/Connector-Net/mysql-connector-net-26.7.0.msi"
}
