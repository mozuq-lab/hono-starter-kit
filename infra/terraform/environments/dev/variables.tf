variable "project" {
  description = "Project name used to name and tag dev foundation resources."
  type        = string
  default     = "hono-starter-kit"
}

variable "environment" {
  description = "Deployment environment for this development foundation."
  type        = string
  default     = "dev"

  validation {
    condition     = var.environment == "dev"
    error_message = "environment must be dev."
  }
}

variable "aws_account_id" {
  description = "操作を許可する AWS アカウントの12桁のID。"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be exactly 12 digits."
  }
}

variable "aws_region" {
  description = "AWS region for regional dev foundation resources."
  type        = string
  default     = "ap-northeast-1"
}

variable "vpc_cidr" {
  description = "IPv4 /16 CIDR allocated to the development VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "app_port" {
  description = "TCP port used by the future application workload and internal ingress."
  type        = number
  default     = 3000
}

variable "api_image" {
  description = "Immutable private ECR API image reference for the ECS workload."
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

variable "task_cpu" {
  description = "Fargate task CPU units for the dev workload."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MiB for the dev workload."
  type        = number
  default     = 1024
}

variable "database_name" {
  description = "PostgreSQL database identifier created for the application."
  type        = string
  default     = "starter"
}

variable "domain_prefix" {
  description = "Globally unique prefix for the standard Cognito hosted domain."
  type        = string
}

variable "alb_deletion_protection" {
  description = "Whether internal ALB deletion protection is enabled."
  type        = bool
  default     = true
}

variable "database_deletion_protection" {
  description = "Whether PostgreSQL deletion protection is enabled."
  type        = bool
  default     = true
}

variable "identity_deletion_protection" {
  description = "Whether Cognito user-pool deletion protection is active."
  type        = bool
  default     = true
}

variable "database_skip_final_snapshot" {
  description = "Whether database deletion skips the deterministic final snapshot."
  type        = bool
  default     = false
}

variable "web_bucket_force_destroy" {
  description = "Whether destroying the web bucket may delete remaining objects and versions."
  type        = bool
  default     = false
}
