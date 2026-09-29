variable "project" {
  description = "Project name used to derive foundation resource names."
  type        = string
}

variable "environment" {
  description = "Deployment environment for this foundation slice."
  type        = string

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
  description = "AWS region for the state bucket and API image repository."
  type        = string
}

variable "state_bucket_name" {
  description = "Globally unique S3 bucket name for Terraform state."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name)) &&
      !strcontains(var.state_bucket_name, "..") &&
      !can(regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", var.state_bucket_name))
    )
    error_message = "state_bucket_name must be a valid 3-63 character S3 bucket name, without consecutive dots or IP-address syntax."
  }
}

variable "github_owner" {
  description = "GitHub repository owner trusted by the OIDC roles."
  type        = string

  validation {
    condition     = length(var.github_owner) > 0 && !can(regex("[\\s:]", var.github_owner))
    error_message = "github_owner must be non-empty and contain no whitespace or colon."
  }
}

variable "github_repository" {
  description = "GitHub repository name trusted by the OIDC roles."
  type        = string

  validation {
    condition     = length(var.github_repository) > 0 && !can(regex("[\\s:]", var.github_repository))
    error_message = "github_repository must be non-empty and contain no whitespace or colon."
  }
}

variable "github_default_branch" {
  description = "GitHub default branch trusted by the plan role."
  type        = string

  validation {
    condition     = length(var.github_default_branch) > 0 && !can(regex("[\\s:]", var.github_default_branch))
    error_message = "github_default_branch must be non-empty and contain no whitespace or colon."
  }
}

variable "create_github_oidc_provider" {
  description = "Whether this bootstrap root owns the GitHub Actions OIDC provider."
  type        = bool
  default     = true
}

variable "create_github_plan_role" {
  description = "Whether to create the GitHub Actions plan role. Keep false until a workflow uses it."
  type        = bool
  default     = false
}

variable "create_github_deploy_role" {
  description = "Whether to create the GitHub Actions deploy role. Keep false until a deploy workflow and a protected GitHub environment exist."
  type        = bool
  default     = false
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub Actions OIDC provider ARN when provider ownership is external."
  type        = string
  default     = null
  nullable    = true
}

variable "state_bucket_force_destroy" {
  description = "Whether destroying the state bucket may delete remaining objects and versions."
  type        = bool
  default     = false
}

variable "ecr_force_delete" {
  description = "Whether deleting the API repository may delete remaining images."
  type        = bool
  default     = false
}
