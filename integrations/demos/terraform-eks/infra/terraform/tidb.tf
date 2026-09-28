# project_id is optional on both resources below: leave var.tidbcloud_project_id
# empty to use the account's default project, or set it (via
# TF_VAR_tidbcloud_project_id / .env's TIDBCLOUD_PROJECT_ID) after looking it
# up with infra/scripts/lookup-project-id.sh.
locals {
  tidbcloud_project_id = var.tidbcloud_project_id != "" ? var.tidbcloud_project_id : null
}

resource "tidbcloud_dedicated_network_container" "this" {
  project_id    = local.tidbcloud_project_id
  region_id     = var.tidbcloud_region_id
  cidr_notation = "10.90.0.0/16"
}

resource "tidbcloud_dedicated_cluster" "this" {
  display_name  = "lab-terraform-eks"
  project_id    = local.tidbcloud_project_id
  region_id     = var.tidbcloud_region_id
  port          = 4000
  root_password = var.tidb_root_password

  # Smallest possible Dedicated configuration this demo is allowed to use:
  # 4C16G is the smallest published node spec for both TiDB and TiKV
  # (pingcap.com/tidb-dedicated-pricing-details, aws-us-west-2, checked
  # 2026-09-28); tidb_node_count=1 is the provider's own minimum (its
  # example uses 1), and tikv_node_count=3 is TiDB Cloud's hard minimum (one
  # set of TiKV nodes across 3 availability zones). No tiflash_node_setting
  # block: this demo does not need HTAP/columnar analytics.
  tidb_node_setting = {
    node_spec_key = var.tidb_node_spec_key
    node_count    = var.tidb_node_count
    public_endpoint_setting = var.connection_mode == "public_tls" ? {
      enabled = true
      ip_access_list = [
        {
          cidr_notation = "0.0.0.0/0"
          description   = "demo: replace with the EKS NAT gateway EIP before recording, or use connection_mode=private instead"
        }
      ]
    } : null
  }

  tikv_node_setting = {
    node_spec_key   = var.tikv_node_spec_key
    node_count      = var.tikv_node_count
    storage_size_gi = var.tikv_storage_size_gi
    storage_type    = "Basic"
  }

  depends_on = [tidbcloud_dedicated_network_container.this]
}
