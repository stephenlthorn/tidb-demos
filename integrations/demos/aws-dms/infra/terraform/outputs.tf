output "aurora_cluster_endpoint" {
  value = aws_rds_cluster.aurora.endpoint
}

output "aurora_cluster_reader_endpoint" {
  value = aws_rds_cluster.aurora.reader_endpoint
}

output "dms_replication_instance_arn" {
  value = aws_dms_replication_instance.this.replication_instance_arn
}

output "dms_replication_task_arn" {
  value = aws_dms_replication_task.this.replication_task_arn
}

output "dms_replication_task_id" {
  value = aws_dms_replication_task.this.replication_task_id
}

output "dms_security_group_id" {
  value       = aws_security_group.dms.id
  description = "Add this security group's associated ENI IPs (or the NAT gateway's public IP, if using a public TiDB Cloud endpoint) to the TiDB Cloud Dedicated cluster's traffic filter."
}

output "vpc_id" {
  value = aws_vpc.this.id
}
