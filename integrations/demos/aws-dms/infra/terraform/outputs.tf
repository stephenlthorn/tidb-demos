output "aurora_cluster_endpoint" {
  value = aws_rds_cluster.aurora.endpoint
}

output "aurora_cluster_reader_endpoint" {
  value = aws_rds_cluster.aurora.reader_endpoint
}

output "aurora_writer_endpoint" {
  value       = aws_rds_cluster_instance.aurora_writer.endpoint
  description = "Aurora writer instance's own endpoint (publicly_accessible, port 5432, TLS required via rds.force_ssl). Fill demos/aws-dms/.env's PG_HOST with this value; the runner also needs PG_SSL=true."
}

output "dms_replication_instance_arn" {
  value = aws_dms_replication_instance.this.replication_instance_arn
}

output "dms_replication_instance_public_ips" {
  value       = aws_dms_replication_instance.this.replication_instance_public_ips
  description = "Public IP(s) the DMS replication instance uses to reach TiDB Cloud Starter's public endpoint. TiDB Cloud Starter connects over the public internet with TLS (verify-full), so no security-group or traffic-filter change on the TiDB Cloud side is required for these IPs."
}

output "dms_replication_task_arn" {
  value = aws_dms_replication_task.this.replication_task_arn
}

output "dms_replication_task_id" {
  value = aws_dms_replication_task.this.replication_task_id
}

output "dms_security_group_id" {
  value       = aws_security_group.dms.id
  description = "Security group attached to the DMS replication instance's ENI."
}

output "vpc_id" {
  value = aws_vpc.this.id
}
