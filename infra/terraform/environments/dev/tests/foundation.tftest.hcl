mock_provider "aws" {
  override_during = plan

  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-northeast-1a", "ap-northeast-1c"] }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-cloudfront-origin-facing" }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/dev/1"
      dns_name = "internal-dev.ap-northeast-1.elb.amazonaws.com"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:targetgroup/dev/1"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE"
      domain_name = "d111111abcdef8.cloudfront.net"
      id          = "EDFDVBD6EXAMPLE"
    }
  }

  mock_resource "aws_cognito_user_pool" {
    defaults = { id = "ap-northeast-1_example" }
  }

  mock_resource "aws_cognito_user_pool_client" {
    defaults = { id = "oidc-client-dev" }
  }

  mock_resource "aws_db_instance" {
    defaults = {
      address  = "starter.cluster-example.ap-northeast-1.rds.amazonaws.com"
      db_name  = "starter"
      endpoint = "starter.cluster-example.ap-northeast-1.rds.amazonaws.com:5432"
      port     = 5432
      master_user_secret = [{
        kms_key_id    = "arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
        secret_arn    = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:rds-dev"
        secret_status = "active"
      }]
    }
  }
}

// tfvars や -var に依存させないため、全変数をここで固定する。既定値を持つ変数は既定値と同じ値にする。
// 値と variables.tf の default の一致は scripts/terraform-test-isolation.test.ts が守る。
variables {
  project                      = "hono-starter-kit"
  environment                  = "dev"
  aws_account_id               = "123456789012"
  aws_region                   = "ap-northeast-1"
  vpc_cidr                     = "10.20.0.0/16"
  app_port                     = 3000
  api_image                    = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  api_repository_arn           = "arn:aws:ecr:ap-northeast-1:123456789012:repository/hono-starter-kit-dev-api"
  adot_image                   = "public.ecr.aws/aws-observability/aws-otel-collector@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  task_cpu                     = 512
  task_memory                  = 1024
  database_name                = "starter"
  domain_prefix                = "hono-starter-kit-dev-example"
  alb_deletion_protection      = true
  database_deletion_protection = true
  identity_deletion_protection = true
  database_skip_final_snapshot = false
  web_bucket_force_destroy     = false
}

run "default_dev_foundation_contract" {
  command = plan

  override_resource {
    override_during = plan
    target          = module.network.aws_vpc.this
    values          = { id = "vpc-dev" }
  }

  override_resource {
    override_during = plan
    target          = module.network.aws_subnet.app[0]
    values          = { id = "subnet-app-a" }
  }

  override_resource {
    override_during = plan
    target          = module.network.aws_subnet.app[1]
    values          = { id = "subnet-app-c" }
  }

  override_resource {
    override_during = plan
    target          = module.network.aws_subnet.db[0]
    values          = { id = "subnet-db-a" }
  }

  override_resource {
    override_during = plan
    target          = module.network.aws_subnet.db[1]
    values          = { id = "subnet-db-c" }
  }

  override_resource {
    override_during = plan
    target          = module.network.aws_security_group.alb
    values          = { id = "sg-alb" }
  }

  override_resource {
    override_during = plan
    target          = module.network.aws_security_group.task
    values          = { id = "sg-task" }
  }

  override_resource {
    override_during = plan
    target          = module.network.aws_security_group.rds
    values          = { id = "sg-rds" }
  }

  override_resource {
    override_during = plan
    target          = module.workload.aws_ecs_cluster.app
    values = {
      arn  = "arn:aws:ecs:ap-northeast-1:123456789012:cluster/hono-starter-kit-dev"
      name = "hono-starter-kit-dev"
    }
  }

  override_resource {
    override_during = plan
    target          = module.workload.aws_ecs_service.app
    values = {
      id   = "arn:aws:ecs:ap-northeast-1:123456789012:service/hono-starter-kit-dev/hono-starter-kit-dev"
      name = "hono-starter-kit-dev"
    }
  }

  override_resource {
    override_during = plan
    target          = module.workload.aws_ecs_task_definition.app
    values = {
      arn = "arn:aws:ecs:ap-northeast-1:123456789012:task-definition/hono-starter-kit-dev:1"
    }
  }

  override_resource {
    override_during = plan
    target          = module.workload.aws_iam_role.task_execution
    values = {
      arn = "arn:aws:iam::123456789012:role/hono-starter-kit-dev-task-execution"
    }
  }

  override_resource {
    override_during = plan
    target          = module.workload.aws_iam_role.runtime_task
    values = {
      arn = "arn:aws:iam::123456789012:role/hono-starter-kit-dev-runtime-task"
    }
  }

  assert {
    condition = (
      var.project == "hono-starter-kit" &&
      var.environment == "dev" &&
      var.aws_region == "ap-northeast-1" &&
      var.vpc_cidr == "10.20.0.0/16" &&
      var.app_port == 3000 &&
      var.database_name == "starter" &&
      var.alb_deletion_protection &&
      var.database_deletion_protection &&
      var.identity_deletion_protection
    )
    error_message = "固定した値（= 既定値。isolation テストが一致を保証する）で、project・environment・region・CIDR・port・database・保護の値が変わっていないこと。"
  }

  assert {
    condition = (
      tolist(data.aws_availability_zones.available.names) == tolist(["ap-northeast-1a", "ap-northeast-1c"]) &&
      tolist(local.availability_zones) == tolist(["ap-northeast-1a", "ap-northeast-1c"]) &&
      length(local.availability_zones) == 2
    )
    error_message = "The dev root must select exactly the first two sorted available ap-northeast-1 availability zones."
  }

  assert {
    condition = (
      output.vpc_id == "vpc-dev" &&
      output.private_app_subnet_ids == ["subnet-app-a", "subnet-app-c"] &&
      output.task_security_group_id == "sg-task" &&
      output.target_group_arn == "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:targetgroup/dev/1"
    )
    error_message = "The next workload slice must receive the composed network and private ingress IDs."
  }

  assert {
    condition = (
      output.database_endpoint == "starter.cluster-example.ap-northeast-1.rds.amazonaws.com" &&
      output.database_port == 5432 &&
      output.database_name == "starter" &&
      output.database_secret_arn == "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:rds-dev"
    )
    error_message = "The next workload slice must receive only private database endpoint and managed-secret metadata."
  }

  assert {
    condition = (
      output.web_bucket_name == "hono-starter-kit-dev-web" &&
      output.distribution_id == "EDFDVBD6EXAMPLE" &&
      output.app_origin == "https://d111111abcdef8.cloudfront.net"
    )
    error_message = "The delivery boundary must expose only the private bucket and default CloudFront application origin metadata."
  }

  assert {
    condition = (
      output.oidc_issuer == "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_example" &&
      output.oidc_client_id == "oidc-client-dev" &&
      output.oidc_authorization_endpoint == "https://hono-starter-kit-dev-example.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize" &&
      output.oidc_logout_endpoint == "https://hono-starter-kit-dev-example.auth.ap-northeast-1.amazoncognito.com/logout"
    )
    error_message = "The next workload slice must receive the composed provider-neutral Cognito OIDC configuration."
  }

  assert {
    condition = (
      var.app_port == 3000 &&
      var.task_cpu == 512 &&
      var.task_memory == 1024 &&
      var.api_image == "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" &&
      var.api_repository_arn == "arn:aws:ecr:ap-northeast-1:123456789012:repository/hono-starter-kit-dev-api" &&
      var.adot_image == "public.ecr.aws/aws-observability/aws-otel-collector@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    error_message = "The dev root must require explicit immutable release inputs and keep its exact Fargate defaults."
  }

  assert {
    condition = (
      output.cluster_name == "hono-starter-kit-dev" &&
      output.cluster_arn == "arn:aws:ecs:ap-northeast-1:123456789012:cluster/hono-starter-kit-dev" &&
      output.service_name == "hono-starter-kit-dev" &&
      output.service_arn == "arn:aws:ecs:ap-northeast-1:123456789012:service/hono-starter-kit-dev/hono-starter-kit-dev" &&
      output.task_definition_arn == "arn:aws:ecs:ap-northeast-1:123456789012:task-definition/hono-starter-kit-dev:1" &&
      output.migration_log_group_name == "/hono-starter-kit/dev/migration" &&
      output.api_log_group_name == "/hono-starter-kit/dev/api" &&
      output.adot_log_group_name == "/hono-starter-kit/dev/adot" &&
      output.task_execution_role_arn == "arn:aws:iam::123456789012:role/hono-starter-kit-dev-task-execution" &&
      output.runtime_task_role_arn == "arn:aws:iam::123456789012:role/hono-starter-kit-dev-runtime-task"
    )
    error_message = "The dev root must expose only workload operational identifiers required by the delivery slice."
  }
}

run "rejects_api_repository_with_a_different_name" {
  command = plan

  variables {
    api_repository_arn = "arn:aws:ecr:ap-northeast-1:123456789012:repository/hono-starter-kit-dev-other"
  }

  expect_failures = [var.api_repository_arn]
}

run "rejects_api_repository_in_a_different_account" {
  command = plan

  variables {
    api_repository_arn = "arn:aws:ecr:ap-northeast-1:210987654321:repository/hono-starter-kit-dev-api"
  }

  expect_failures = [var.api_repository_arn]
}

run "rejects_api_repository_in_a_different_region" {
  command = plan

  variables {
    api_repository_arn = "arn:aws:ecr:us-east-1:123456789012:repository/hono-starter-kit-dev-api"
  }

  expect_failures = [var.api_repository_arn]
}

run "rejects_malformed_api_repository_arn" {
  command = plan

  variables {
    api_repository_arn = "not-an-ecr-repository-arn"
  }

  expect_failures = [var.api_repository_arn]
}

run "protections_default_to_protected" {
  command = plan

  assert {
    condition     = module.data.deletion_protection_effective == true
    error_message = "固定した値（= 既定値。isolation テストが一致を保証する）で RDS の削除保護が有効になること。"
  }

  assert {
    condition     = module.edge.web_bucket_force_destroy_effective == false
    error_message = "固定した値（= 既定値。isolation テストが一致を保証する）で、空でない web bucket の destroy を拒否すること。"
  }

  assert {
    condition     = module.data.skip_final_snapshot_effective == false
    error_message = "固定した値（= 既定値。isolation テストが一致を保証する）で、DB 削除時に final snapshot を取ること。"
  }
}

run "release_values_disable_every_protection" {
  command = plan

  variables {
    alb_deletion_protection      = false
    database_deletion_protection = false
    identity_deletion_protection = false
    database_skip_final_snapshot = true
    web_bucket_force_destroy     = true
  }

  assert {
    condition     = module.data.deletion_protection_effective == false
    error_message = "The release value must disable RDS deletion protection."
  }

  assert {
    condition     = module.data.skip_final_snapshot_effective == true
    error_message = "The release value must skip the final snapshot."
  }

  assert {
    condition     = module.edge.web_bucket_force_destroy_effective == true
    error_message = "The release value must allow destroying a non-empty web bucket."
  }
}

run "rejects_empty_aws_account_id" {
  command = plan

  variables {
    aws_account_id = ""
  }

  expect_failures = [var.aws_account_id]
}

run "rejects_short_aws_account_id" {
  command = plan

  variables {
    aws_account_id = "12345678901"
  }

  expect_failures = [var.aws_account_id]
}

run "rejects_long_aws_account_id" {
  command = plan

  variables {
    aws_account_id = "1234567890123"
  }

  expect_failures = [var.aws_account_id]
}

run "rejects_nonnumeric_aws_account_id" {
  command = plan

  variables {
    aws_account_id = "12345678901a"
  }

  expect_failures = [var.aws_account_id]
}
