mock_provider "aws" {}

variables {
  project               = "hono-starter-kit"
  environment           = "dev"
  db_subnet_ids         = ["subnet-db-a", "subnet-db-c"]
  rds_security_group_id = "sg-rds"
  database_name         = "starter"
}

run "private_postgres_uses_managed_credentials" {
  command = plan

  override_resource {
    override_during = plan
    target          = aws_db_subnet_group.postgres
    values = {
      name = "hono-starter-kit-dev-postgres"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_db_parameter_group.postgres
    values = {
      name = "hono-starter-kit-dev-postgres16-test"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_db_instance.postgres
    values = {
      address  = "postgres.internal"
      endpoint = "postgres.internal:5432"
      port     = 5432
      master_user_secret = [{
        kms_key_id    = "arn:aws:kms:ap-northeast-1:123456789012:key/managed-secret-key"
        secret_arn    = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:rds-managed"
        secret_status = "active"
      }]
    }
  }

  assert {
    condition = (
      aws_db_instance.postgres.identifier == "hono-starter-kit-dev-postgres" &&
      aws_db_instance.postgres.engine == "postgres" &&
      aws_db_instance.postgres.engine_version == "16" &&
      aws_db_instance.postgres.instance_class == "db.t4g.micro" &&
      aws_db_instance.postgres.allocated_storage == 20 &&
      aws_db_instance.postgres.storage_type == "gp3"
    )
    error_message = "The database must use the exact PostgreSQL 16 dev compute and storage defaults."
  }

  assert {
    condition = (
      aws_db_instance.postgres.storage_encrypted &&
      !aws_db_instance.postgres.publicly_accessible &&
      !aws_db_instance.postgres.multi_az &&
      aws_db_instance.postgres.backup_retention_period == 7 &&
      aws_db_instance.postgres.deletion_protection &&
      !aws_db_instance.postgres.skip_final_snapshot &&
      aws_db_instance.postgres.final_snapshot_identifier == "hono-starter-kit-dev-postgres-final" &&
      !aws_db_instance.postgres.apply_immediately
    )
    error_message = "The database must remain encrypted, private, Single-AZ, recoverable, protected, and maintenance-window applied."
  }

  assert {
    condition = (
      aws_db_instance.postgres.db_name == "starter" &&
      aws_db_instance.postgres.username == "starter_admin" &&
      aws_db_instance.postgres.manage_master_user_password &&
      aws_db_instance.postgres.password == null
    )
    error_message = "RDS must manage the starter_admin password without a Terraform password value."
  }

  assert {
    condition = (
      aws_db_subnet_group.postgres.subnet_ids == toset(["subnet-db-a", "subnet-db-c"]) &&
      aws_db_instance.postgres.db_subnet_group_name == "hono-starter-kit-dev-postgres" &&
      aws_db_instance.postgres.vpc_security_group_ids == toset(["sg-rds"])
    )
    error_message = "The database must use exactly the two supplied private DB subnets and only the supplied RDS security group."
  }

  assert {
    condition = (
      aws_db_parameter_group.postgres.name_prefix == "hono-starter-kit-dev-postgres16-" &&
      aws_db_parameter_group.postgres.family == "postgres16" &&
      one(aws_db_parameter_group.postgres.parameter).name == "rds.force_ssl" &&
      one(aws_db_parameter_group.postgres.parameter).value == "1" &&
      one(aws_db_parameter_group.postgres.parameter).apply_method == "pending-reboot" &&
      aws_db_instance.postgres.parameter_group_name == "hono-starter-kit-dev-postgres16-test"
    )
    error_message = "The PostgreSQL 16 parameter group must require TLS after reboot and be attached to the instance."
  }

  assert {
    condition = (
      aws_db_subnet_group.postgres.tags == tomap({
        Project     = "hono-starter-kit"
        Environment = "dev"
        ManagedBy   = "Terraform"
      }) &&
      aws_db_parameter_group.postgres.tags == aws_db_subnet_group.postgres.tags &&
      aws_db_instance.postgres.tags == aws_db_subnet_group.postgres.tags
    )
    error_message = "Every taggable data resource must carry only the exact project, environment, and management tags."
  }

  assert {
    condition = (
      output.database_endpoint == "postgres.internal" &&
      output.database_port == 5432 &&
      output.database_name == "starter" &&
      output.database_secret_arn == "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:rds-managed"
    )
    error_message = "The module must expose only the database connection metadata and managed secret ARN contract."
  }
}

run "lifecycle_flags_are_forwarded" {
  command = plan

  variables {
    deletion_protection = false
    skip_final_snapshot = true
  }

  assert {
    condition = (
      !aws_db_instance.postgres.deletion_protection &&
      aws_db_instance.postgres.skip_final_snapshot &&
      aws_db_instance.postgres.final_snapshot_identifier == "hono-starter-kit-dev-postgres-final"
    )
    error_message = "Lifecycle flags must be forwarded while preserving the deterministic final snapshot identifier."
  }
}

run "rejects_one_db_subnet" {
  command = plan

  variables {
    db_subnet_ids = ["subnet-db-a"]
  }

  expect_failures = [var.db_subnet_ids]
}

run "rejects_three_db_subnets" {
  command = plan

  variables {
    db_subnet_ids = ["subnet-db-a", "subnet-db-c", "subnet-db-d"]
  }

  expect_failures = [var.db_subnet_ids]
}

run "rejects_duplicate_db_subnets" {
  command = plan

  variables {
    db_subnet_ids = ["subnet-db-a", "subnet-db-a"]
  }

  expect_failures = [var.db_subnet_ids]
}

run "rejects_non_t4g_instance_class" {
  command = plan

  variables {
    instance_class = "db.t3.micro"
  }

  expect_failures = [var.instance_class]
}

run "rejects_malformed_t4g_instance_class" {
  command = plan

  variables {
    instance_class = "db.t4gmalformed"
  }

  expect_failures = [var.instance_class]
}

run "rejects_storage_below_range" {
  command = plan

  variables {
    allocated_storage = 19
  }

  expect_failures = [var.allocated_storage]
}

run "rejects_storage_above_range" {
  command = plan

  variables {
    allocated_storage = 101
  }

  expect_failures = [var.allocated_storage]
}

run "rejects_database_name_starting_with_digit" {
  command = plan

  variables {
    database_name = "1starter"
  }

  expect_failures = [var.database_name]
}

run "rejects_database_name_with_non_identifier_character" {
  command = plan

  variables {
    database_name = "starter-db"
  }

  expect_failures = [var.database_name]
}

run "rejects_database_name_over_postgres_limit" {
  command = plan

  variables {
    database_name = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [var.database_name]
}
