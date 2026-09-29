locals {
  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "Terraform"
  }

  public_cidrs = [for index in range(2) : cidrsubnet(var.vpc_cidr, 8, index)]
  app_cidrs    = [for index in range(2) : cidrsubnet(var.vpc_cidr, 8, 16 + index)]
  db_cidrs     = [for index in range(2) : cidrsubnet(var.vpc_cidr, 8, 32 + index)]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = local.common_tags
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = local.common_tags
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = local.public_cidrs[count.index]
  map_public_ip_on_launch = true

  tags = local.common_tags
}

resource "aws_subnet" "app" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = local.app_cidrs[count.index]
  map_public_ip_on_launch = false

  tags = local.common_tags
}

resource "aws_subnet" "db" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = local.db_cidrs[count.index]
  map_public_ip_on_launch = false

  tags = local.common_tags
}

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = local.common_tags
}

resource "aws_nat_gateway" "this" {
  count = 1

  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = local.common_tags

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  count = 2

  vpc_id = aws_vpc.this.id
  tags   = local.common_tags
}

resource "aws_route" "public_default" {
  count = 2

  route_table_id         = aws_route_table.public[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[count.index].id
}

resource "aws_route_table" "app" {
  count = 2

  vpc_id = aws_vpc.this.id
  tags   = local.common_tags
}

resource "aws_route" "app_default" {
  count = 2

  route_table_id         = aws_route_table.app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "app" {
  count = 2

  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

resource "aws_route_table" "db" {
  count = 2

  vpc_id = aws_vpc.this.id
  tags   = local.common_tags
}

resource "aws_route_table_association" "db" {
  count = 2

  subnet_id      = aws_subnet.db[count.index].id
  route_table_id = aws_route_table.db[count.index].id
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.project}-${var.environment}-alb"
  description = "CloudFront origin access to the application load balancer"
  vpc_id      = aws_vpc.this.id

  tags = local.common_tags
}

resource "aws_security_group" "task" {
  name        = "${var.project}-${var.environment}-task"
  description = "Application task traffic"
  vpc_id      = aws_vpc.this.id

  tags = local.common_tags
}

resource "aws_security_group" "rds" {
  name        = "${var.project}-${var.environment}-rds"
  description = "PostgreSQL traffic from application tasks"
  vpc_id      = aws_vpc.this.id

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the CloudFront origin-facing prefix list"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  from_port         = 80
  ip_protocol       = "tcp"
  to_port           = 80

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  description                  = "Application traffic from the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.app_port
  ip_protocol                  = "tcp"
  to_port                      = var.app_port

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_task" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL traffic from application tasks"
  referenced_security_group_id = aws_security_group.task.id
  from_port                    = 5432
  ip_protocol                  = "tcp"
  to_port                      = 5432

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "alb_to_task" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Application traffic to tasks"
  referenced_security_group_id = aws_security_group.task.id
  from_port                    = var.app_port
  ip_protocol                  = "tcp"
  to_port                      = var.app_port

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "task_to_rds" {
  security_group_id            = aws_security_group.task.id
  description                  = "PostgreSQL traffic to RDS"
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  ip_protocol                  = "tcp"
  to_port                      = 5432

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "task_https" {
  security_group_id = aws_security_group.task.id
  description       = "HTTPS to external services"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "task_dns_tcp" {
  security_group_id = aws_security_group.task.id
  description       = "TCP DNS inside the VPC"
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  ip_protocol       = "tcp"
  to_port           = 53

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "task_dns_udp" {
  security_group_id = aws_security_group.task.id
  description       = "UDP DNS inside the VPC"
  cidr_ipv4         = var.vpc_cidr
  from_port         = 53
  ip_protocol       = "udp"
  to_port           = 53

  tags = local.common_tags
}
