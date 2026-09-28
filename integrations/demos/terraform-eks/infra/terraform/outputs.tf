output "cluster_id" {
  value = tidbcloud_dedicated_cluster.this.cluster_id
}

output "connection_endpoint_kind" {
  value = var.connection_mode
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

# No LoadBalancer hostname: the app Service is ClusterIP (see k8s.tf), so the
# runner reaches it with `kubectl port-forward svc/lab-app <local>:80
# --context <eks_cluster_name>` and talks to localhost instead.
output "app_service_name" {
  value = kubernetes_service_v1.app.metadata[0].name
}
