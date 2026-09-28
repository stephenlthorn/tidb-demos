data "aws_caller_identity" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name_prefix}-vpc", Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-igw", Project = "tidb-integration-lab", Demo = "aws-dms" }
}

# Two public subnets hold both the DMS replication instance and Aurora. Both
# are publicly_accessible: DMS needs to reach TiDB Cloud Starter's public
# endpoint, and Aurora needs to be reachable from the coordinator's Mac
# (which runs the demo's runner) since this VPC has no bastion or VPN. This
# is cheaper than a NAT gateway for a short demo run (Section 4/5 of the
# plan). Two subnets/AZs because the DMS replication subnet group and
# Aurora's DB subnet group both require at least two AZs.
resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name_prefix}-public-${count.index}", Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name_prefix}-public-rt", Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "aurora" {
  name        = "${var.name_prefix}-aurora-sg"
  description = "Aurora PostgreSQL source: inbound 5432 from DMS and from the admin CIDR only (TLS required via rds.force_ssl)."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "PostgreSQL from DMS replication instance"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.dms.id]
  }

  ingress {
    description = "PostgreSQL from the admin CIDR (the demo runners workstation public IP), since this demo has no bastion or VPN and the runner needs direct access for writes, checksums, and cutover"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-aurora-sg", Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_security_group" "dms" {
  name        = "${var.name_prefix}-dms-sg"
  description = "DMS replication instance: outbound to Aurora (5432) and TiDB Cloud Starters public endpoint (4000) over the internet gateway, inbound none required."
  vpc_id      = aws_vpc.this.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-dms-sg", Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.name_prefix}-aurora-subnets"
  subnet_ids = aws_subnet.public[*].id
  tags       = { Name = "${var.name_prefix}-aurora-subnets", Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_rds_cluster_parameter_group" "aurora_logical_replication" {
  name        = "${var.name_prefix}-aurora-pg-cpg"
  family      = "aurora-postgresql16"
  description = "Enables logical replication so DMS CDC can use pglogical or test_decoding, and requires TLS since Aurora is reachable from the public internet (Section 4)."

  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "immediate"
  }

  tags = { Project = "tidb-integration-lab", Demo = "aws-dms" }
}

# Aurora PostgreSQL Serverless v2, floor 0.5 ACU. Chosen over a provisioned
# db.t4g.medium instance because this demo's Aurora writer only needs to be
# fully warm during full-load/cdc-live/validate/cutover, and Serverless v2
# bills per second at its floor the rest of the time, which is cheaper for a
# ~2 hour run than a provisioned instance billed the full hourly rate
# throughout (Section 5). engine_mode must be "provisioned" for Serverless v2
# (this is not the older, unsupported Aurora Serverless v1 "serverless" mode).
resource "aws_rds_cluster" "aurora" {
  cluster_identifier              = "${var.name_prefix}-aurora"
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = var.aurora_engine_version
  master_username                 = var.aurora_master_username
  master_password                 = var.aurora_master_password
  database_name                   = var.aurora_database_name
  db_subnet_group_name            = aws_db_subnet_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora_logical_replication.name
  skip_final_snapshot             = true
  apply_immediately               = true

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }

  tags = { Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_rds_cluster_instance" "aurora_writer" {
  identifier          = "${var.name_prefix}-aurora-writer"
  cluster_identifier  = aws_rds_cluster.aurora.id
  engine              = aws_rds_cluster.aurora.engine
  engine_version      = aws_rds_cluster.aurora.engine_version
  instance_class      = "db.serverless"
  publicly_accessible = true
  apply_immediately   = true

  tags       = { Project = "tidb-integration-lab", Demo = "aws-dms" }
  depends_on = [aws_route_table_association.public]
}

resource "aws_dms_replication_subnet_group" "this" {
  replication_subnet_group_id          = "${var.name_prefix}-dms-subnets"
  replication_subnet_group_description = "Public subnets for the DMS replication instance (Section 4/5: publicly_accessible instead of a NAT gateway)."
  subnet_ids                           = aws_subnet.public[*].id
}

resource "aws_dms_replication_instance" "this" {
  replication_instance_id     = "${var.name_prefix}-repl"
  replication_instance_class  = var.dms_instance_class
  allocated_storage           = var.dms_allocated_storage_gb
  vpc_security_group_ids      = [aws_security_group.dms.id]
  replication_subnet_group_id = aws_dms_replication_subnet_group.this.id
  publicly_accessible         = true
  multi_az                    = false
  depends_on                  = [aws_iam_role_policy_attachment.dms_vpc_role, aws_iam_role_policy_attachment.dms_cloudwatch_logs_role, aws_route_table_association.public]

  tags = { Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_dms_endpoint" "source_aurora" {
  endpoint_id   = "${var.name_prefix}-source-aurora"
  endpoint_type = "source"
  engine_name   = "aurora-postgresql"
  server_name   = aws_rds_cluster.aurora.endpoint
  port          = 5432
  username      = var.aurora_master_username
  password      = var.aurora_master_password
  database_name = var.aurora_database_name

  tags = { Project = "tidb-integration-lab", Demo = "aws-dms" }
}

# TiDB Cloud Starter certificate presented over its public endpoint chains to
# ISRG Root X1 (Let's Encrypt); DMS needs that CA imported so ssl_mode
# verify-full can validate the chain and the hostname (Section 4).
resource "aws_dms_certificate" "tidb_ca" {
  certificate_id  = "${var.name_prefix}-tidb-ca"
  certificate_pem = file("${path.module}/certs/isrg-root-x1.pem")
}

resource "aws_dms_endpoint" "target_tidb" {
  endpoint_id                 = "${var.name_prefix}-target-tidb"
  endpoint_type               = "target"
  engine_name                 = "mysql"
  server_name                 = var.tidb_host
  port                        = var.tidb_port
  username                    = var.tidb_user
  password                    = var.tidb_password
  database_name               = var.aurora_database_name
  ssl_mode                    = "verify-full"
  certificate_arn             = aws_dms_certificate.tidb_ca.certificate_arn
  extra_connection_attributes = "Initstmt=SET FOREIGN_KEY_CHECKS=0;"

  lifecycle {
    ignore_changes = [password]
  }

  tags = { Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_dms_replication_task" "this" {
  replication_task_id      = "${var.name_prefix}-task"
  replication_instance_arn = aws_dms_replication_instance.this.replication_instance_arn
  source_endpoint_arn      = aws_dms_endpoint.source_aurora.endpoint_arn
  target_endpoint_arn      = aws_dms_endpoint.target_tidb.endpoint_arn
  migration_type           = "full-load-and-cdc"
  table_mappings           = file("${path.module}/table-mappings.json")

  replication_task_settings = jsonencode({
    ValidationSettings = {
      EnableValidation = true
      ThreadCount      = 5
    }
    Logging = {
      EnableLogging = true
    }
  })

  tags = { Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_iam_role" "dms_vpc_role" {
  count = var.create_dms_service_roles ? 1 : 0
  name  = "dms-vpc-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "dms.amazonaws.com" }
    }]
  })

  tags = { Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_iam_role_policy_attachment" "dms_vpc_role" {
  count      = var.create_dms_service_roles ? 1 : 0
  role       = aws_iam_role.dms_vpc_role[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole"
}

resource "aws_iam_role" "dms_cloudwatch_logs_role" {
  count = var.create_dms_service_roles ? 1 : 0
  name  = "dms-cloudwatch-logs-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "dms.amazonaws.com" }
    }]
  })

  tags = { Project = "tidb-integration-lab", Demo = "aws-dms" }
}

resource "aws_iam_role_policy_attachment" "dms_cloudwatch_logs_role" {
  count      = var.create_dms_service_roles ? 1 : 0
  role       = aws_iam_role.dms_cloudwatch_logs_role[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonDMSCloudWatchLogsRole"
}
