data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Latest Windows Server 2022 English Full Base AMI, published by AWS as a public SSM parameter.
data "aws_ssm_parameter" "windows_2022" {
  name = "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base"
}

resource "tls_private_key" "windows" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "windows" {
  key_name   = "${var.name_prefix}-key"
  public_key = tls_private_key.windows.public_key_openssh
}

# Private key is written locally (never committed) so the coordinator can decrypt the
# Administrator password with `aws ec2 get-password-data` (see outputs.tf).
resource "local_file" "windows_private_key" {
  content         = tls_private_key.windows.private_key_pem
  filename        = "${path.module}/generated/${var.name_prefix}-key.pem"
  file_permission = "0600"
}

resource "aws_security_group" "windows_rdp" {
  name        = "${var.name_prefix}-rdp-sg"
  description = "RDP (3389) inbound from a single operator IP only; all outbound allowed for installer downloads and the TiDB Cloud connection."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "RDP from the operator current public IP"
    from_port   = 3389
    to_port     = 3389
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-rdp-sg" }
}

resource "aws_instance" "power_bi_desktop" {
  ami                         = data.aws_ssm_parameter.windows_2022.value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.windows_rdp.id]
  key_name                    = aws_key_pair.windows.key_name
  associate_public_ip_address = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/user_data.ps1.tpl", {
    power_bi_installer_url              = var.power_bi_installer_url
    mysql_connector_net_url             = var.mysql_connector_net_url
    dashboard_query_revenue_by_category = "SELECT product_category, SUM(amount) AS revenue, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 GROUP BY product_category"
    dashboard_query_orders_by_region    = "SELECT region, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 GROUP BY region"
    dashboard_query_orders_last_hour    = "SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS minute_bucket, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 AND created_at >= NOW() - INTERVAL 60 MINUTE GROUP BY minute_bucket ORDER BY minute_bucket"
  })

  tags = { Name = "${var.name_prefix}-desktop" }
}
