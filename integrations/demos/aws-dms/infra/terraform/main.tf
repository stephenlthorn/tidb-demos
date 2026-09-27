data "aws_caller_identity" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = var.availability_zones[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name_prefix}-public" }
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  tags              = { Name = "${var.name_prefix}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.name_prefix}-nat-eip" }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "${var.name_prefix}-nat" }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name_prefix}-public-rt" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
  tags = { Name = "${var.name_prefix}-private-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "aurora" {
  name        = "${var.name_prefix}-aurora-sg"
  description = "Aurora PostgreSQL source: inbound 5432 from DMS and the runner's egress, outbound to NAT for patching only."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "PostgreSQL from DMS replication instance"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.dms.id]
  }

  ingress {
    description = "PostgreSQL from the demo runner (public egress via NAT for local development)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-aurora-sg" }
}

resource "aws_security_group" "dms" {
  name        = "${var.name_prefix}-dms-sg"
  description = "DMS replication instance: outbound to Aurora (5432) and TiDB Cloud (4000), inbound none required."
  vpc_id      = aws_vpc.this.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-dms-sg" }
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.name_prefix}-aurora-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${var.name_prefix}-aurora-subnets" }
}

resource "aws_rds_cluster_parameter_group" "aurora_logical_replication" {
  name        = "${var.name_prefix}-aurora-pg-cpg"
  family      = "aurora-postgresql15"
  description = "Enables logical replication so DMS CDC can use pglogical or test_decoding (Section 4)."

  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier              = "${var.name_prefix}-aurora"
  engine                          = "aurora-postgresql"
  engine_version                  = var.aurora_engine_version
  master_username                 = var.aurora_master_username
  master_password                 = var.aurora_master_password
  database_name                   = var.aurora_database_name
  db_subnet_group_name            = aws_db_subnet_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora_logical_replication.name
  skip_final_snapshot             = true
  apply_immediately               = true
}

resource "aws_rds_cluster_instance" "aurora_writer" {
  identifier          = "${var.name_prefix}-aurora-writer"
  cluster_identifier  = aws_rds_cluster.aurora.id
  engine              = aws_rds_cluster.aurora.engine
  engine_version      = aws_rds_cluster.aurora.engine_version
  instance_class      = var.aurora_instance_class
  publicly_accessible = false
  apply_immediately   = true
}

resource "aws_dms_replication_subnet_group" "this" {
  replication_subnet_group_id          = "${var.name_prefix}-dms-subnets"
  replication_subnet_group_description = "Private subnets for the DMS replication instance."
  subnet_ids                           = aws_subnet.private[*].id
}

resource "aws_dms_replication_instance" "this" {
  replication_instance_id     = "${var.name_prefix}-repl"
  replication_instance_class  = var.dms_instance_class
  allocated_storage           = var.dms_allocated_storage_gb
  vpc_security_group_ids      = [aws_security_group.dms.id]
  replication_subnet_group_id = aws_dms_replication_subnet_group.this.id
  publicly_accessible         = false
  multi_az                    = false
  depends_on                  = [aws_iam_role_policy_attachment.dms_vpc_role, aws_iam_role_policy_attachment.dms_cloudwatch_logs_role]
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
}

resource "aws_dms_endpoint" "target_tidb" {
  endpoint_id                 = "${var.name_prefix}-target-tidb"
  endpoint_type               = "target"
  engine_name                 = "mysql"
  server_name                 = var.tidb_host
  port                        = var.tidb_port
  username                    = "root"
  password                    = "REPLACE_BEFORE_APPLY"
  database_name               = var.aurora_database_name
  ssl_mode                    = "verify-full"
  extra_connection_attributes = "Initstmt=SET FOREIGN_KEY_CHECKS=0;"

  lifecycle {
    ignore_changes = [password]
  }
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
}

resource "aws_iam_role" "dms_vpc_role" {
  name = "dms-vpc-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "dms.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dms_vpc_role" {
  role       = aws_iam_role.dms_vpc_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole"
}

resource "aws_iam_role" "dms_cloudwatch_logs_role" {
  name = "dms-cloudwatch-logs-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "dms.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dms_cloudwatch_logs_role" {
  role       = aws_iam_role.dms_cloudwatch_logs_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonDMSCloudWatchLogsRole"
}
