locals {
  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "Terraform"
  }

  task_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  common_environment_by_name = {
    NODE_ENV                       = "production"
    AWS_REGION                     = var.aws_region
    PORT                           = tostring(var.app_port)
    PGHOST                         = var.database_endpoint
    PGPORT                         = tostring(var.database_port)
    PGDATABASE                     = var.database_name
    PGPASSWORD_SECRET_ARN          = var.database_secret_arn
    PGSSLROOTCERT                  = "/app/certs/global-bundle.pem"
    AUTH_PROVIDER                  = "oidc"
    APP_ORIGIN                     = var.app_origin
    OIDC_ISSUER                    = var.oidc_issuer
    OIDC_CLIENT_ID                 = var.oidc_client_id
    OIDC_LOGOUT_ENDPOINT           = var.oidc_logout_endpoint
    OIDC_LOGOUT_REDIRECT_PARAMETER = "logout_uri"
    OTEL_TRACES_EXPORTER           = "otlp"
    OTEL_EXPORTER_OTLP_PROTOCOL    = "http/protobuf"
    OTEL_EXPORTER_OTLP_ENDPOINT    = "http://127.0.0.1:4318"
    OTEL_SERVICE_NAME              = "hono-starter-api"
  }

  common_environment = [
    for name in sort(keys(local.common_environment_by_name)) : {
      name  = name
      value = local.common_environment_by_name[name]
    }
  ]

  database_secret_selectors = [
    {
      name      = "PGUSER"
      valueFrom = "${var.database_secret_arn}:username::"
    },
  ]

  adot_config_content = <<-YAML
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 128
        spike_limit_mib: 32
      batch: {}
    exporters:
      awsxray:
        region: $${env:AWS_REGION}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [awsxray]
  YAML
}

resource "aws_cloudwatch_log_group" "migration" {
  name              = "/${var.project}/${var.environment}/migration"
  retention_in_days = 14

  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/${var.project}/${var.environment}/api"
  retention_in_days = 14

  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "adot" {
  name              = "/${var.project}/${var.environment}/adot"
  retention_in_days = 14

  tags = local.common_tags
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project}-${var.environment}-task-execution"
  assume_role_policy = local.task_assume_role_policy

  tags = local.common_tags
}

resource "aws_iam_role" "runtime_task" {
  name               = "${var.project}-${var.environment}-runtime-task"
  assume_role_policy = local.task_assume_role_policy

  tags = local.common_tags
}

resource "aws_iam_role_policy" "task_execution" {
  name = "${var.project}-${var.environment}-task-execution"
  role = aws_iam_role.task_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuthorization"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrRepositoryRead"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = var.api_repository_arn
      },
      {
        Sid    = "LogWrite"
        Effect = "Allow"
        Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = [
          "${aws_cloudwatch_log_group.migration.arn}:*",
          "${aws_cloudwatch_log_group.api.arn}:*",
          "${aws_cloudwatch_log_group.adot.arn}:*",
        ]
      },
      {
        Sid      = "DatabaseSecretRead"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.database_secret_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "runtime_task" {
  name = "${var.project}-${var.environment}-runtime-task"
  role = aws_iam_role.runtime_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
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
  })
}

resource "aws_ecs_cluster" "app" {
  name = "${var.project}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project}-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.runtime_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name        = "migration"
      image       = var.api_image
      essential   = false
      command     = ["node", "/app/migrate.mjs"]
      environment = local.common_environment
      secrets     = local.database_secret_selectors
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.migration.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "migration"
        }
      }
    },
    {
      name        = "api"
      image       = var.api_image
      essential   = true
      command     = ["node", "/app/api.mjs"]
      environment = local.common_environment
      secrets     = local.database_secret_selectors
      dependsOn = [{
        containerName = "migration"
        condition     = "SUCCESS"
      }]
      portMappings = [{
        containerPort = var.app_port
        protocol      = "tcp"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api"
        }
      }
    },
    {
      name      = "adot"
      image     = var.adot_image
      essential = false
      environment = [
        {
          name  = "AOT_CONFIG_CONTENT"
          value = local.adot_config_content
        },
        {
          name  = "AWS_REGION"
          value = var.aws_region
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.adot.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "adot"
        }
      }
    },
  ])

  tags = local.common_tags
}

resource "aws_ecs_service" "app" {
  name            = "${var.project}-${var.environment}"
  cluster         = aws_ecs_cluster.app.arn
  task_definition = aws_ecs_task_definition.app.arn
  launch_type     = "FARGATE"
  desired_count   = 1

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  wait_for_steady_state              = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_app_subnet_ids
    security_groups  = [var.task_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = var.app_port
  }

  depends_on = [
    aws_iam_role_policy.task_execution,
    aws_iam_role_policy.runtime_task,
  ]

  tags = local.common_tags
}
