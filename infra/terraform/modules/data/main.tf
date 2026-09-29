locals {
  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

resource "aws_db_subnet_group" "postgres" {
  name       = "${var.project}-${var.environment}-postgres"
  subnet_ids = var.db_subnet_ids

  tags = local.common_tags
}

resource "aws_db_parameter_group" "postgres" {
  name_prefix = "${var.project}-${var.environment}-postgres16-"
  family      = "postgres16"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  tags = local.common_tags
}

resource "aws_db_instance" "postgres" {
  identifier                  = "${var.project}-${var.environment}-postgres"
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = var.instance_class
  allocated_storage           = var.allocated_storage
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = var.database_name
  username                    = "starter_admin"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.postgres.name
  parameter_group_name        = aws_db_parameter_group.postgres.name
  vpc_security_group_ids      = [var.rds_security_group_id]
  publicly_accessible         = false
  multi_az                    = false
  backup_retention_period     = 7
  deletion_protection         = var.deletion_protection
  skip_final_snapshot         = var.skip_final_snapshot
  final_snapshot_identifier   = "${var.project}-${var.environment}-postgres-final"
  apply_immediately           = false

  tags = local.common_tags
}
