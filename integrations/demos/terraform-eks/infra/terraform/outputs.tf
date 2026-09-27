output "cluster_id" {
  value = tidbcloud_dedicated_cluster.this.cluster_id
}

output "connection_endpoint_kind" {
  value = var.connection_mode
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "app_service_hostname" {
  value = try(kubernetes_service_v1.app.status[0].load_balancer[0].ingress[0].hostname, "")
}
