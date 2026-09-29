variable "project" {
  description = "Project name used for resource names and tags."
  type        = string
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
  description = "AWS region used to construct provider-neutral OIDC endpoints."
  type        = string
}

variable "app_origin" {
  description = "Public HTTPS application origin without credentials, path, query, or fragment."
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$", var.app_origin))
    error_message = "app_origin must be an HTTPS origin without credentials, path, query, or fragment."
  }
}

variable "domain_prefix" {
  description = "Globally unique prefix for the standard Cognito hosted domain."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.domain_prefix))
    error_message = "domain_prefix must be 1-63 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen."
  }
}

variable "deletion_protection" {
  description = "Whether Cognito deletion protection is active."
  type        = bool
  default     = true
}
