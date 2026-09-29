mock_provider "aws" {}

variables {
  project                = "hono-starter-kit"
  environment            = "dev"
  aws_region             = "ap-northeast-1"
  private_app_subnet_ids = ["subnet-app-a", "subnet-app-c"]
  task_security_group_id = "sg-task"
  target_group_arn       = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:targetgroup/hono/1234567890abcdef"
  app_port               = 3000
  api_image              = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  api_repository_arn     = "arn:aws:ecr:ap-northeast-1:123456789012:repository/hono-starter-kit-dev-api"
  adot_image             = "public.ecr.aws/aws-observability/aws-otel-collector@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  database_endpoint      = "postgres.internal"
  database_port          = 5432
  database_name          = "starter"
  database_secret_arn    = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:rds-managed"
  app_origin             = "https://app.example.com"
  oidc_issuer            = "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_testpool"
  oidc_client_id         = "public-client-id"
  oidc_logout_endpoint   = "https://hono-starter-kit-dev.auth.ap-northeast-1.amazoncognito.com/logout"
  task_cpu               = 512
  task_memory            = 1024
}

run "accepts_complete_secretless_inputs" {
  command = plan
}

run "rejects_non_dev_environment" {
  command = plan

  variables {
    environment = "prod"
  }

  expect_failures = [var.environment]
}

run "rejects_mutable_api_tag" {
  command = plan

  variables {
    api_image = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api:latest"
  }

  expect_failures = [var.api_image]
}

run "rejects_api_tag_plus_digest" {
  command = plan

  variables {
    api_image = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api:release@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [var.api_image]
}

run "rejects_uppercase_api_digest" {
  command = plan

  variables {
    api_image = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }

  expect_failures = [var.api_image]
}

run "rejects_whitespace_around_api_image" {
  command = plan

  variables {
    api_image = " 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [var.api_image]
}

run "rejects_malformed_api_repository_arn" {
  command = plan

  variables {
    api_repository_arn = "not-an-ecr-repository-arn"
  }

  expect_failures = [var.api_repository_arn]
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

run "rejects_mutable_adot_tag" {
  command = plan

  variables {
    adot_image = "public.ecr.aws/aws-observability/aws-otel-collector:latest"
  }

  expect_failures = [var.adot_image]
}

run "rejects_alternate_adot_repository" {
  command = plan

  variables {
    adot_image = "public.ecr.aws/alternate/aws-otel-collector@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }

  expect_failures = [var.adot_image]
}

run "rejects_uppercase_adot_digest" {
  command = plan

  variables {
    adot_image = "public.ecr.aws/aws-observability/aws-otel-collector@sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  }

  expect_failures = [var.adot_image]
}

run "rejects_whitespace_around_adot_image" {
  command = plan

  variables {
    adot_image = "public.ecr.aws/aws-observability/aws-otel-collector@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "
  }

  expect_failures = [var.adot_image]
}

run "rejects_one_private_app_subnet" {
  command = plan

  variables {
    private_app_subnet_ids = ["subnet-app-a"]
  }

  expect_failures = [var.private_app_subnet_ids]
}

run "rejects_three_private_app_subnets" {
  command = plan

  variables {
    private_app_subnet_ids = ["subnet-app-a", "subnet-app-c", "subnet-app-d"]
  }

  expect_failures = [var.private_app_subnet_ids]
}

run "rejects_duplicate_private_app_subnets" {
  command = plan

  variables {
    private_app_subnet_ids = ["subnet-app-a", "subnet-app-a"]
  }

  expect_failures = [var.private_app_subnet_ids]
}

run "rejects_blank_private_app_subnet" {
  command = plan

  variables {
    private_app_subnet_ids = ["subnet-app-a", "   "]
  }

  expect_failures = [var.private_app_subnet_ids]
}

run "rejects_app_port_below_range" {
  command = plan

  variables {
    app_port = 0
  }

  expect_failures = [var.app_port]
}

run "rejects_app_port_above_range" {
  command = plan

  variables {
    app_port = 65536
  }

  expect_failures = [var.app_port]
}

run "rejects_database_port_below_range" {
  command = plan

  variables {
    database_port = 0
  }

  expect_failures = [var.database_port]
}

run "rejects_database_port_above_range" {
  command = plan

  variables {
    database_port = 65536
  }

  expect_failures = [var.database_port]
}

run "rejects_http_app_origin" {
  command = plan

  variables {
    app_origin = "http://app.example.com"
  }

  expect_failures = [var.app_origin]
}

run "rejects_http_oidc_issuer" {
  command = plan

  variables {
    oidc_issuer = "http://identity.example.com/issuer"
  }

  expect_failures = [var.oidc_issuer]
}

run "rejects_http_oidc_logout_endpoint" {
  command = plan

  variables {
    oidc_logout_endpoint = "http://identity.example.com/logout"
  }

  expect_failures = [var.oidc_logout_endpoint]
}

run "rejects_app_origin_credentials" {
  command = plan

  variables {
    app_origin = "https://user:password@app.example.com"
  }

  expect_failures = [var.app_origin]
}

run "rejects_oidc_issuer_credentials" {
  command = plan

  variables {
    oidc_issuer = "https://user:password@identity.example.com/issuer"
  }

  expect_failures = [var.oidc_issuer]
}

run "rejects_oidc_logout_endpoint_credentials" {
  command = plan

  variables {
    oidc_logout_endpoint = "https://user:password@identity.example.com/logout"
  }

  expect_failures = [var.oidc_logout_endpoint]
}

run "rejects_blank_identifiers" {
  command = plan

  variables {
    project                = "   "
    aws_region             = "   "
    task_security_group_id = "   "
    target_group_arn       = "   "
    api_repository_arn     = "   "
    database_endpoint      = "   "
    database_name          = "   "
    database_secret_arn    = "   "
    oidc_client_id         = "   "
  }

  expect_failures = [
    var.project,
    var.aws_region,
    var.task_security_group_id,
    var.target_group_arn,
    var.api_repository_arn,
    var.database_endpoint,
    var.database_name,
    var.database_secret_arn,
    var.oidc_client_id,
  ]
}

run "accepts_512_cpu_with_1024_memory" {
  command = plan
}

run "accepts_256_cpu_upper_memory_boundary" {
  command = plan

  variables {
    task_cpu    = 256
    task_memory = 2048
  }
}

run "accepts_512_cpu_upper_memory_boundary" {
  command = plan

  variables {
    task_cpu    = 512
    task_memory = 4096
  }
}

run "accepts_1024_cpu_upper_memory_boundary" {
  command = plan

  variables {
    task_cpu    = 1024
    task_memory = 8192
  }
}

run "accepts_2048_cpu_upper_memory_boundary" {
  command = plan

  variables {
    task_cpu    = 2048
    task_memory = 16384
  }
}

run "accepts_4096_cpu_upper_memory_boundary" {
  command = plan

  variables {
    task_cpu    = 4096
    task_memory = 30720
  }
}

run "accepts_8192_cpu_upper_memory_boundary" {
  command = plan

  variables {
    task_cpu    = 8192
    task_memory = 61440
  }
}

run "accepts_16384_cpu_upper_memory_boundary" {
  command = plan

  variables {
    task_cpu    = 16384
    task_memory = 122880
  }
}

run "rejects_256_cpu_with_256_memory" {
  command = plan

  variables {
    task_cpu    = 256
    task_memory = 256
  }

  expect_failures = [check.fargate_size]
}

run "rejects_512_cpu_with_512_memory" {
  command = plan

  variables {
    task_cpu    = 512
    task_memory = 512
  }

  expect_failures = [check.fargate_size]
}

run "rejects_8192_cpu_with_8192_memory" {
  command = plan

  variables {
    task_cpu    = 8192
    task_memory = 8192
  }

  expect_failures = [check.fargate_size]
}

run "rejects_16384_cpu_above_memory_range" {
  command = plan

  variables {
    task_cpu    = 16384
    task_memory = 131072
  }

  expect_failures = [check.fargate_size]
}

run "creates_workload_logs_and_least_privilege_roles" {
  command = plan

  override_resource {
    override_during = plan
    target          = aws_cloudwatch_log_group.migration
    values = {
      arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/hono-starter-kit/dev/migration"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cloudwatch_log_group.api
    values = {
      arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/hono-starter-kit/dev/api"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cloudwatch_log_group.adot
    values = {
      arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/hono-starter-kit/dev/adot"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_iam_role.task_execution
    values = {
      arn = "arn:aws:iam::123456789012:role/hono-starter-kit-dev-task-execution"
      id  = "hono-starter-kit-dev-task-execution"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_iam_role.runtime_task
    values = {
      arn = "arn:aws:iam::123456789012:role/hono-starter-kit-dev-runtime-task"
      id  = "hono-starter-kit-dev-runtime-task"
    }
  }

  assert {
    condition = (
      aws_cloudwatch_log_group.migration.name == "/hono-starter-kit/dev/migration" &&
      aws_cloudwatch_log_group.api.name == "/hono-starter-kit/dev/api" &&
      aws_cloudwatch_log_group.adot.name == "/hono-starter-kit/dev/adot" &&
      aws_cloudwatch_log_group.migration.retention_in_days == 14 &&
      aws_cloudwatch_log_group.api.retention_in_days == 14 &&
      aws_cloudwatch_log_group.adot.retention_in_days == 14 &&
      aws_cloudwatch_log_group.migration.tags == tomap({
        Project     = "hono-starter-kit"
        Environment = "dev"
        ManagedBy   = "Terraform"
      }) &&
      aws_cloudwatch_log_group.api.tags == aws_cloudwatch_log_group.migration.tags &&
      aws_cloudwatch_log_group.adot.tags == aws_cloudwatch_log_group.migration.tags
    )
    error_message = "Migration, API, and ADOT logs must have exact names, retention, and ownership tags."
  }

  assert {
    condition = (
      output.migration_log_group_name == aws_cloudwatch_log_group.migration.name &&
      output.api_log_group_name == aws_cloudwatch_log_group.api.name &&
      output.adot_log_group_name == aws_cloudwatch_log_group.adot.name &&
      output.task_execution_role_arn == aws_iam_role.task_execution.arn &&
      output.runtime_task_role_arn == aws_iam_role.runtime_task.arn
    )
    error_message = "The workload contract must expose only its log names and distinct execution and runtime role ARNs."
  }

  assert {
    condition = (
      aws_iam_role.task_execution.name != aws_iam_role.runtime_task.name &&
      aws_iam_role.task_execution.assume_role_policy == aws_iam_role.runtime_task.assume_role_policy &&
      jsondecode(aws_iam_role.task_execution.assume_role_policy).Version == "2012-10-17" &&
      jsondecode(aws_iam_role.runtime_task.assume_role_policy).Version == "2012-10-17" &&
      length(jsondecode(aws_iam_role.task_execution.assume_role_policy).Statement) == 1 &&
      length(jsondecode(aws_iam_role.runtime_task.assume_role_policy).Statement) == 1 &&
      one(jsondecode(aws_iam_role.task_execution.assume_role_policy).Statement).Effect == "Allow" &&
      one(jsondecode(aws_iam_role.runtime_task.assume_role_policy).Statement).Effect == "Allow" &&
      one(jsondecode(aws_iam_role.task_execution.assume_role_policy).Statement).Principal.Service == "ecs-tasks.amazonaws.com" &&
      one(jsondecode(aws_iam_role.runtime_task.assume_role_policy).Statement).Principal.Service == "ecs-tasks.amazonaws.com" &&
      one(jsondecode(aws_iam_role.task_execution.assume_role_policy).Statement).Action == "sts:AssumeRole" &&
      one(jsondecode(aws_iam_role.runtime_task.assume_role_policy).Statement).Action == "sts:AssumeRole"
    )
    error_message = "Both roles must use the ECS-tasks-only trust policy while remaining separate roles."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.task_execution.policy).Version == "2012-10-17" &&
      length(jsondecode(aws_iam_role_policy.task_execution.policy).Statement) == 4 &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "EcrAuthorization"
      ]).Effect == "Allow" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "EcrAuthorization"
      ]).Action == ["ecr:GetAuthorizationToken"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "EcrAuthorization"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "EcrRepositoryRead"
      ]).Effect == "Allow" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "EcrRepositoryRead"
        ]).Action == [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "EcrRepositoryRead"
      ]).Resource == var.api_repository_arn &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "LogWrite"
      ]).Effect == "Allow" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "LogWrite"
      ]).Action == ["logs:CreateLogStream", "logs:PutLogEvents"] &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "LogWrite"
        ]).Resource) == toset([
        "${aws_cloudwatch_log_group.migration.arn}:*",
        "${aws_cloudwatch_log_group.api.arn}:*",
        "${aws_cloudwatch_log_group.adot.arn}:*",
      ]) &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "DatabaseSecretRead"
      ]).Effect == "Allow" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "DatabaseSecretRead"
      ]).Action == ["secretsmanager:GetSecretValue"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.task_execution.policy).Statement : statement
        if statement.Sid == "DatabaseSecretRead"
      ]).Resource == var.database_secret_arn
    )
    error_message = "The execution role policy must contain only the exact ECR, log-write, and managed-secret permissions."
  }

  assert {
    condition = (
      aws_iam_role_policy.task_execution.role == aws_iam_role.task_execution.id &&
      aws_iam_role_policy.runtime_task.role == aws_iam_role.runtime_task.id
    )
    error_message = "Each inline policy must attach to its intended ECS role."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.runtime_task.policy).Version == "2012-10-17" &&
      jsondecode(aws_iam_role_policy.runtime_task.policy).Statement == [
        {
          Sid    = "XrayTelemetry"
          Effect = "Allow"
          Action = [
            "xray:PutTraceSegments",
            "xray:PutTelemetryRecords",
            "xray:GetSamplingRules",
            "xray:GetSamplingTargets",
            "xray:GetSamplingStatisticSummaries",
          ]
          Resource = "*"
        },
        {
          Sid      = "DatabaseSecretRead"
          Effect   = "Allow"
          Action   = ["secretsmanager:GetSecretValue"]
          Resource = var.database_secret_arn
        },
      ]
    )
    error_message = "Runtime role は既存 X-Ray 権限と対象 DB secret の取得だけを許可し、接続ごとに更新された password を取得できる必要がある。"
  }

  assert {
    condition = alltrue([
      for policy in [
        jsondecode(aws_iam_role_policy.task_execution.policy),
        jsondecode(aws_iam_role_policy.runtime_task.policy),
        ] : (
        !strcontains(lower(jsonencode(policy)), "iam:passrole") &&
        !strcontains(lower(jsonencode(policy)), "accesskey") &&
        !strcontains(lower(jsonencode(policy)), "secretaccesskey") &&
        !strcontains(lower(jsonencode(policy)), "github") &&
        alltrue([
          for action in flatten([for statement in policy.Statement : statement.Action]) : (
            !startswith(action, "iam:") &&
            !startswith(action, "ssm:") &&
            !startswith(action, "terraform:") &&
            !startswith(action, "rds:") &&
            !startswith(action, "rds-data:") &&
            !startswith(action, "dynamodb:") &&
            !startswith(action, "s3:")
          )
        ])
      )
    ])
    error_message = "Workload policies must exclude role passing, static credentials, Terraform, GitHub, SSM, and application-data access."
  }
}

run "creates_private_three_container_fargate_service" {
  command = plan

  override_resource {
    override_during = plan
    target          = aws_iam_role.task_execution
    values = {
      arn = "arn:aws:iam::123456789012:role/hono-starter-kit-dev-task-execution"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_iam_role.runtime_task
    values = {
      arn = "arn:aws:iam::123456789012:role/hono-starter-kit-dev-runtime-task"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_ecs_cluster.app
    values = {
      arn = "arn:aws:ecs:ap-northeast-1:123456789012:cluster/hono-starter-kit-dev"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_ecs_task_definition.app
    values = {
      arn = "arn:aws:ecs:ap-northeast-1:123456789012:task-definition/hono-starter-kit-dev:1"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_ecs_service.app
    values = {
      id = "arn:aws:ecs:ap-northeast-1:123456789012:service/hono-starter-kit-dev/hono-starter-kit-dev"
    }
  }

  assert {
    condition = (
      length(jsondecode(aws_ecs_task_definition.app.container_definitions)) == 3 &&
      toset([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container.name
      ]) == toset(["migration", "api", "adot"])
    )
    error_message = "The task definition must contain exactly the migration, API, and ADOT containers."
  }

  assert {
    condition = (
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "migration"
      ]).image == var.api_image &&
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "migration"
      ]).essential == false &&
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "migration"
      ]).command == ["node", "/app/migrate.mjs"] &&
      !contains(keys(one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "migration"
      ])), "portMappings")
    )
    error_message = "The migration container must run the pinned API image as a nonessential one-off without a port mapping."
  }

  assert {
    condition = (
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "api"
      ]).image == var.api_image &&
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "api"
      ]).essential == true &&
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "api"
      ]).command == ["node", "/app/api.mjs"] &&
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "api"
        ]).dependsOn == [{
        containerName = "migration"
        condition     = "SUCCESS"
      }] &&
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "api"
        ]).portMappings == [{
        containerPort = var.app_port
        protocol      = "tcp"
      }]
    )
    error_message = "The essential API must wait for migration success and expose only its configured TCP port."
  }

  assert {
    condition = (
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "adot"
      ]).image == var.adot_image &&
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "adot"
      ]).essential == false &&
      one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container
        if container.name == "api"
        ]).dependsOn == [{
        containerName = "migration"
        condition     = "SUCCESS"
      }]
    )
    error_message = "The nonessential ADOT sidecar must not gate API startup."
  }

  assert {
    condition = alltrue([
      for container_name in ["migration", "api"] : one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container.environment
        if container.name == container_name
        ]) == [
        { name = "APP_ORIGIN", value = var.app_origin },
        { name = "AUTH_PROVIDER", value = "oidc" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "NODE_ENV", value = "production" },
        { name = "OIDC_CLIENT_ID", value = var.oidc_client_id },
        { name = "OIDC_ISSUER", value = var.oidc_issuer },
        { name = "OIDC_LOGOUT_ENDPOINT", value = var.oidc_logout_endpoint },
        { name = "OIDC_LOGOUT_REDIRECT_PARAMETER", value = "logout_uri" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://127.0.0.1:4318" },
        { name = "OTEL_EXPORTER_OTLP_PROTOCOL", value = "http/protobuf" },
        { name = "OTEL_SERVICE_NAME", value = "hono-starter-api" },
        { name = "OTEL_TRACES_EXPORTER", value = "otlp" },
        { name = "PGDATABASE", value = var.database_name },
        { name = "PGHOST", value = var.database_endpoint },
        { name = "PGPASSWORD_SECRET_ARN", value = var.database_secret_arn },
        { name = "PGPORT", value = tostring(var.database_port) },
        { name = "PGSSLROOTCERT", value = "/app/certs/global-bundle.pem" },
        { name = "PORT", value = tostring(var.app_port) },
      ]
    ])
    error_message = "Migration and API must receive the exact deterministic non-secret production environment."
  }

  assert {
    condition = alltrue([
      for container_name in ["migration", "api"] : one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container.secrets
        if container.name == container_name
        ]) == [
        { name = "PGUSER", valueFrom = "${var.database_secret_arn}:username::" },
      ]
    ])
    error_message = "Migration と API の起動時注入は username のみとし、rotation で古くなる password を環境変数へ固定しない。"
  }

  assert {
    condition = alltrue([
      for container_name in ["migration", "api"] : (
        !contains(one([
          for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : [
            for item in container.environment : item.name
          ]
          if container.name == container_name
        ]), "DATABASE_URL") &&
        length(setintersection(
          toset(one([
            for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : [
              for item in container.environment : item.name
            ]
            if container.name == container_name
          ])),
          toset(["PGUSER", "PGPASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]),
        )) == 0
      )
    ])
    error_message = "Task environment values must not contain DATABASE_URL, database credentials, or AWS access keys."
  }

  assert {
    condition = (
      yamldecode(one([
        for item in one([
          for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container.environment
          if container.name == "adot"
        ]) : item.value
        if item.name == "AOT_CONFIG_CONTENT"
        ])) == {
        receivers = {
          otlp = {
            protocols = {
              http = {
                endpoint = "0.0.0.0:4318"
              }
            }
          }
        }
        processors = {
          memory_limiter = {
            check_interval  = "1s"
            limit_mib       = 128
            spike_limit_mib = 32
          }
          batch = {}
        }
        exporters = {
          awsxray = {
            region = "$${env:AWS_REGION}"
          }
        }
        service = {
          pipelines = {
            traces = {
              receivers  = ["otlp"]
              processors = ["memory_limiter", "batch"]
              exporters  = ["awsxray"]
            }
          }
        }
      } &&
      {
        for item in one([
          for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container.environment
          if container.name == "adot"
        ]) : item.name => item.value
      }["AWS_REGION"] == var.aws_region &&
      toset([
        for item in one([
          for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container.environment
          if container.name == "adot"
        ]) : item.name
      ]) == toset(["AOT_CONFIG_CONTENT", "AWS_REGION"])
    )
    error_message = "ADOT must receive only AWS_REGION and the exact trace-only OTLP-to-X-Ray collector configuration."
  }

  assert {
    condition = alltrue([
      for container_name in ["migration", "api", "adot"] : one([
        for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container.logConfiguration
        if container.name == container_name
        ]) == {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/${var.project}/${var.environment}/${container_name}"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = container_name
        }
      }
    ])
    error_message = "Each container must send logs to its own 14-day awslogs group and stream prefix."
  }

  assert {
    condition = (
      aws_ecs_cluster.app.name == "${var.project}-${var.environment}" &&
      one(aws_ecs_cluster.app.setting).name == "containerInsights" &&
      one(aws_ecs_cluster.app.setting).value == "disabled" &&
      aws_ecs_task_definition.app.family == "${var.project}-${var.environment}" &&
      aws_ecs_task_definition.app.requires_compatibilities == toset(["FARGATE"]) &&
      aws_ecs_task_definition.app.network_mode == "awsvpc" &&
      aws_ecs_task_definition.app.cpu == "512" &&
      aws_ecs_task_definition.app.memory == "1024" &&
      one(aws_ecs_task_definition.app.runtime_platform).cpu_architecture == "X86_64" &&
      one(aws_ecs_task_definition.app.runtime_platform).operating_system_family == "LINUX" &&
      aws_ecs_task_definition.app.execution_role_arn == aws_iam_role.task_execution.arn &&
      aws_ecs_task_definition.app.task_role_arn == aws_iam_role.runtime_task.arn
    )
    error_message = "The task must use the distinct roles and exact Linux X86_64 Fargate runtime with Container Insights disabled."
  }

  assert {
    condition = (
      aws_ecs_service.app.name == "${var.project}-${var.environment}" &&
      aws_ecs_service.app.cluster == aws_ecs_cluster.app.arn &&
      aws_ecs_service.app.task_definition == aws_ecs_task_definition.app.arn &&
      aws_ecs_service.app.launch_type == "FARGATE" &&
      aws_ecs_service.app.desired_count == 1 &&
      aws_ecs_service.app.health_check_grace_period_seconds == 60 &&
      aws_ecs_service.app.deployment_minimum_healthy_percent == 100 &&
      aws_ecs_service.app.deployment_maximum_percent == 200 &&
      aws_ecs_service.app.wait_for_steady_state == true &&
      one(aws_ecs_service.app.deployment_circuit_breaker).enable == true &&
      one(aws_ecs_service.app.deployment_circuit_breaker).rollback == true
    )
    error_message = "The ECS service must run one steady-state Fargate task with the exact safe deployment settings."
  }

  assert {
    condition = (
      toset(one(aws_ecs_service.app.network_configuration).subnets) == toset(var.private_app_subnet_ids) &&
      toset(one(aws_ecs_service.app.network_configuration).security_groups) == toset([var.task_security_group_id]) &&
      one(aws_ecs_service.app.network_configuration).assign_public_ip == false &&
      length(aws_ecs_service.app.load_balancer) == 1 &&
      one(aws_ecs_service.app.load_balancer).target_group_arn == var.target_group_arn &&
      one(aws_ecs_service.app.load_balancer).container_name == "api" &&
      one(aws_ecs_service.app.load_balancer).container_port == var.app_port
    )
    error_message = "The service must attach only API to the target group from the two private subnets without a public IP."
  }

  assert {
    condition = (
      output.cluster_name == aws_ecs_cluster.app.name &&
      output.cluster_arn == aws_ecs_cluster.app.arn &&
      output.service_name == aws_ecs_service.app.name &&
      output.service_arn == aws_ecs_service.app.id &&
      output.task_definition_arn == aws_ecs_task_definition.app.arn
    )
    error_message = "The workload module must export only the operational ECS identifiers."
  }
}
