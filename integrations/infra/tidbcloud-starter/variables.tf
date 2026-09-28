variable "name" {
  description = "Lab workspace identifier, used as the cluster display name (e.g. lab-06, lab-12)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be a lowercase, dash-separated identifier such as lab-06."
  }
}

variable "region" {
  description = "TiDB Cloud Starter region name, in the regions/{region-id} format."
  type        = string
  default     = "regions/aws-us-west-2"
}
