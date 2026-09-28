output "cluster_id" {
  description = "TiDB Cloud cluster ID."
  value       = tidbcloud_serverless_cluster.this.cluster_id
}

output "host" {
  description = "Public endpoint host."
  value       = tidbcloud_serverless_cluster.this.endpoints.public.host
}

output "port" {
  description = "Public endpoint port."
  value       = tidbcloud_serverless_cluster.this.endpoints.public.port
}

output "user_prefix" {
  description = "The cluster's unique SQL user prefix."
  value       = tidbcloud_serverless_cluster.this.user_prefix
}

output "user" {
  description = "Full SQL username for the root user (Starter usernames are prefixed)."
  value       = "${tidbcloud_serverless_cluster.this.user_prefix}.root"
}

output "password" {
  description = "Root user password."
  value       = random_password.root.result
  sensitive   = true
}
