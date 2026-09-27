resource "tidbcloud_dedicated_network_container" "this" {
  region_id     = var.tidbcloud_region_id
  cidr_notation = "10.90.0.0/16"
}

resource "tidbcloud_dedicated_cluster" "this" {
  display_name  = "lab-terraform-eks"
  region_id     = var.tidbcloud_region_id
  port          = 4000
  root_password = var.tidb_root_password

  tidb_node_setting = {
    node_spec_key = "2C4G"
    node_count    = var.tidb_node_count
    public_endpoint_setting = var.connection_mode == "public_tls" ? {
      enabled = true
      ip_access_list = [
        {
          cidr_notation = "0.0.0.0/0"
          description   = "demo: replace with the EKS NAT gateway EIP before recording"
        }
      ]
    } : null
  }

  tikv_node_setting = {
    node_spec_key   = "2C4G"
    node_count      = var.tikv_node_count
    storage_size_gi = var.tikv_storage_size_gi
    storage_type    = "Basic"
  }

  depends_on = [tidbcloud_dedicated_network_container.this]
}
