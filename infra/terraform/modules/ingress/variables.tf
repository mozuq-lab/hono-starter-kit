variable "project" {
  description = "Project name used to name and tag ingress resources."
  type        = string
}

variable "environment" {
  description = "Deployment environment used to name and tag ingress resources."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID used by the application target group."
  type        = string
}

variable "private_app_subnet_ids" {
  description = "Two distinct private application subnet IDs for the internal ALB."
  type        = list(string)

  validation {
    condition = (
      length(var.private_app_subnet_ids) == 2 &&
      length(toset(var.private_app_subnet_ids)) == 2
    )
    error_message = "private_app_subnet_ids must contain exactly two distinct subnet IDs."
  }
}

variable "alb_security_group_id" {
  description = "Security group ID that permits CloudFront origin traffic to the ALB."
  type        = string
}

variable "app_port" {
  description = "TCP port exposed by application IP targets."
  type        = number

  validation {
    condition     = var.app_port >= 1 && var.app_port <= 65535
    error_message = "app_port must be between 1 and 65535."
  }
}

variable "deletion_protection" {
  description = "Whether ALB deletion protection is enabled."
  type        = bool
  default     = true
}
