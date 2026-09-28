# One TiDB Cloud Starter (serverless) cluster per workspace/var.name.
#
# TiDB Cloud Starter is shared, fully-managed infrastructure: it has no
# AWS resources of its own to tag, so the Project/Demo tagging convention
# used elsewhere in this repo does not apply here. The cluster's
# display_name (var.name) is what a cost sweep should key off instead.

resource "tidbcloud_serverless_cluster" "this" {
  display_name = var.name
  project_id   = var.project_id

  region = {
    name = var.region
  }

  # 0 keeps the cluster on the free quota. An organization that already has
  # its maximum number of free clusters needs a small non-zero cap instead.
  spending_limit = {
    monthly = var.monthly_spending_limit_usd_cents
  }
}

# The cluster is created with a default "<user_prefix>.root" admin user
# whose password TiDB Cloud generates and never exposes. The provider has
# no root_password argument on tidbcloud_serverless_cluster, so the
# documented way to set our own password is to bring that same user under
# Terraform management with tidbcloud_sql_user (see up.sh, which imports
# it once the cluster exists) and set the password here.
resource "random_password" "root" {
  length           = 20
  special          = true
  override_special = "-_=+"
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
}

resource "tidbcloud_sql_user" "root" {
  cluster_id   = tidbcloud_serverless_cluster.this.cluster_id
  user_name    = "${tidbcloud_serverless_cluster.this.user_prefix}.root"
  password     = random_password.root.result
  builtin_role = "role_admin"
}
