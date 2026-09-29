variable "project" {
  description = "Project name used to tag network resources."
  type        = string
}

variable "environment" {
  description = "Deployment environment used to name and tag network resources."
  type        = string
}

variable "vpc_cidr" {
  description = "IPv4 /16 CIDR allocated to the VPC."
  type        = string

  validation {
    condition = (
      can(cidrnetmask(var.vpc_cidr)) &&
      can(regex("/16$", var.vpc_cidr))
    )
    error_message = "vpc_cidr must be a valid IPv4 /16 CIDR."
  }
}

variable "availability_zones" {
  description = "Two distinct availability zones used in stable subnet order."
  type        = list(string)

  validation {
    condition = (
      length(var.availability_zones) == 2 &&
      length(toset(var.availability_zones)) == 2
    )
    error_message = "availability_zones must contain exactly two distinct availability zone names."
  }
}

variable "app_port" {
  description = "TCP port exposed by application tasks behind the ALB."
  type        = number

  validation {
    condition     = var.app_port >= 1 && var.app_port <= 65535
    error_message = "app_port must be between 1 and 65535."
  }
}
