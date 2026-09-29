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
  # TiDB Cloud auto-provisions exactly one network container per
  # project/region (confirmed live: creating a second one, at any CIDR,
  # fails with "CIDR already exists"). This CIDR is the one the account's
  # Thorn-Sandbox project already has for aws-us-west-2, found via the
  # tidbcloud_dedicated_network_containers list data source and imported
  # into state rather than created. See the plan's Build notes.
  cidr_notation = "172.30.24.0/21"

  # The provider's Read() does not populate region_id/cidr_notation after
  # import (only network_container_id, state, cloud_provider, vpc_id, and
  # labels come back), and Update() unconditionally errors for this resource
  # ("Update is not supported for dedicated network container"), so without
  # ignore_changes here every subsequent plan would show a fictitious diff
  # that can never actually apply.
  lifecycle {
    ignore_changes = [region_id, cidr_notation]
  }
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
    # Confirmed live: TiDB Cloud rejects storage_type "Basic" (the provider's
    # own bundled example's value, used for the smaller 2C4G spec) for the
    # 4C16G spec on aws with the account's current TiDB version, with
    # "Storage type Basic is not supported in provider aws for node spec
    # 4C16G and TiDB version v8.5.8." Standard (gp3 data disk + gp3 raft log
    # disk) is the next tier up and is accepted.
    storage_type = "Standard"
  }

  depends_on = [tidbcloud_dedicated_network_container.this]
}
