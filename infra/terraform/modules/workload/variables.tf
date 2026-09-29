variable "project" {
  description = "Project name used for workload resource names and tags."
  type        = string

  validation {
    condition     = trimspace(var.project) != ""
    error_message = "project must not be blank."
  }
}

variable "environment" {
  description = "Deployment environment. This development module accepts only dev."
  type        = string

  validation {
    condition     = var.environment == "dev"
    error_message = "environment must be dev."
  }
}

variable "aws_region" {
  description = "AWS region for workload resources."
  type        = string

  validation {
    condition     = trimspace(var.aws_region) != ""
    error_message = "aws_region must not be blank."
  }
}

variable "private_app_subnet_ids" {
  description = "Two distinct private application subnet IDs for the ECS service."
  type        = list(string)

  validation {
    condition = (
      length(var.private_app_subnet_ids) == 2 &&
      length(toset(var.private_app_subnet_ids)) == 2 &&
      alltrue([
        for subnet_id in var.private_app_subnet_ids : trimspace(subnet_id) != ""
      ])
    )
    error_message = "private_app_subnet_ids must contain exactly two distinct, non-blank subnet IDs."
  }
}

variable "task_security_group_id" {
  description = "Security group ID attached to application tasks."
  type        = string

  validation {
    condition     = trimspace(var.task_security_group_id) != ""
    error_message = "task_security_group_id must not be blank."
  }
}

variable "target_group_arn" {
  description = "Application Load Balancer target group ARN for the ECS service."
  type        = string

  validation {
    condition     = trimspace(var.target_group_arn) != ""
    error_message = "target_group_arn must not be blank."
  }
}

variable "app_port" {
  description = "TCP port exposed by the API container."
  type        = number

  validation {
    condition     = var.app_port >= 1 && var.app_port <= 65535
    error_message = "app_port must be from 1 through 65535."
  }
}

variable "api_image" {
  description = "Immutable private ECR API image reference."
  type        = string

  validation {
    condition = can(regex(
      "^[0-9]{12}\\.dkr\\.ecr\\.[a-z]{2}(-[a-z0-9]+)+-[0-9]\\.amazonaws\\.com/[a-z0-9]+([-._/][a-z0-9]+)*@sha256:[0-9a-f]{64}$",
      var.api_image,
    ))
    error_message = "api_image must be a private ECR repository reference pinned to one lowercase sha256 digest."
  }
}

variable "api_repository_arn" {
  description = "Private ECR repository ARN that the task execution role may pull from."
  type        = string

  validation {
    condition     = trimspace(var.api_repository_arn) != ""
    error_message = "api_repository_arn must not be blank."
  }

  validation {
    condition = can(regex(
      "^arn:aws:ecr:[a-z]{2}(-[a-z0-9]+)+-[0-9]:[0-9]{12}:repository/[a-z0-9]+([-._/][a-z0-9]+)*$",
      var.api_repository_arn,
    ))
    error_message = "api_repository_arn must be a private ECR repository ARN."
  }

  validation {
    condition = try(
      regex("^([0-9]{12})\\.dkr\\.ecr\\.([a-z]{2}(-[a-z0-9]+)+-[0-9])\\.amazonaws\\.com/([a-z0-9]+([-._/][a-z0-9]+)*)@sha256:[0-9a-f]{64}$", var.api_image)[0] == regex("^arn:aws:ecr:([a-z]{2}(-[a-z0-9]+)+-[0-9]):([0-9]{12}):repository/([a-z0-9]+([-._/][a-z0-9]+)*)$", var.api_repository_arn)[2] &&
      regex("^([0-9]{12})\\.dkr\\.ecr\\.([a-z]{2}(-[a-z0-9]+)+-[0-9])\\.amazonaws\\.com/([a-z0-9]+([-._/][a-z0-9]+)*)@sha256:[0-9a-f]{64}$", var.api_image)[1] == regex("^arn:aws:ecr:([a-z]{2}(-[a-z0-9]+)+-[0-9]):([0-9]{12}):repository/([a-z0-9]+([-._/][a-z0-9]+)*)$", var.api_repository_arn)[0] &&
      regex("^([0-9]{12})\\.dkr\\.ecr\\.([a-z]{2}(-[a-z0-9]+)+-[0-9])\\.amazonaws\\.com/([a-z0-9]+([-._/][a-z0-9]+)*)@sha256:[0-9a-f]{64}$", var.api_image)[3] == regex("^arn:aws:ecr:([a-z]{2}(-[a-z0-9]+)+-[0-9]):([0-9]{12}):repository/([a-z0-9]+([-._/][a-z0-9]+)*)$", var.api_repository_arn)[3],
      false,
    )
    error_message = "api_repository_arn must identify the exact private ECR repository in api_image."
  }

}

variable "adot_image" {
  description = "Immutable AWS Distro for OpenTelemetry collector image reference."
  type        = string

  validation {
    condition = can(regex(
      "^public\\.ecr\\.aws/aws-observability/aws-otel-collector@sha256:[0-9a-f]{64}$",
      var.adot_image,
    ))
    error_message = "adot_image must use the exact public AWS ADOT repository pinned to one lowercase sha256 digest."
  }
}

variable "database_endpoint" {
  description = "Private PostgreSQL endpoint hostname."
  type        = string

  validation {
    condition     = trimspace(var.database_endpoint) != ""
    error_message = "database_endpoint must not be blank."
  }
}

variable "database_port" {
  description = "PostgreSQL endpoint port."
  type        = number

  validation {
    condition     = var.database_port >= 1 && var.database_port <= 65535
    error_message = "database_port must be from 1 through 65535."
  }
}

variable "database_name" {
  description = "PostgreSQL database name."
  type        = string

  validation {
    condition     = trimspace(var.database_name) != ""
    error_message = "database_name must not be blank."
  }
}

variable "database_secret_arn" {
  description = "ARN of the AWS-managed database credential secret."
  type        = string

  validation {
    condition     = trimspace(var.database_secret_arn) != ""
    error_message = "database_secret_arn must not be blank."
  }
}

variable "app_origin" {
  description = "Absolute HTTPS public application origin."
  type        = string

  validation {
    condition = can(regex(
      "^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[^[:space:]]*)?$",
      var.app_origin,
    ))
    error_message = "app_origin must be an absolute HTTPS URL without credentials."
  }
}

variable "oidc_issuer" {
  description = "Absolute HTTPS OIDC issuer URL."
  type        = string

  validation {
    condition = can(regex(
      "^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[^[:space:]]*)?$",
      var.oidc_issuer,
    ))
    error_message = "oidc_issuer must be an absolute HTTPS URL without credentials."
  }
}

variable "oidc_client_id" {
  description = "Public OIDC client identifier."
  type        = string

  validation {
    condition     = trimspace(var.oidc_client_id) != ""
    error_message = "oidc_client_id must not be blank."
  }
}

variable "oidc_logout_endpoint" {
  description = "Absolute HTTPS OIDC provider logout endpoint."
  type        = string

  validation {
    condition = can(regex(
      "^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[^[:space:]]*)?$",
      var.oidc_logout_endpoint,
    ))
    error_message = "oidc_logout_endpoint must be an absolute HTTPS URL without credentials."
  }
}

variable "task_cpu" {
  description = "Fargate task CPU units."
  type        = number
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
}

locals {
  fargate_memory_by_cpu = tomap({
    "256"   = tolist([512, 1024, 2048])
    "512"   = tolist([1024, 2048, 3072, 4096])
    "1024"  = range(2048, 9216, 1024)
    "2048"  = range(4096, 17408, 1024)
    "4096"  = range(8192, 31744, 1024)
    "8192"  = range(16384, 65536, 4096)
    "16384" = range(32768, 131072, 8192)
  })
}

check "fargate_size" {
  assert {
    condition = contains(
      lookup(local.fargate_memory_by_cpu, tostring(var.task_cpu), []),
      var.task_memory,
    )
    error_message = "task_cpu and task_memory must form a supported Fargate size."
  }
}
