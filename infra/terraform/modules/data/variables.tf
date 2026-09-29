variable "project" {
  description = "Project name used to name and tag database resources."
  type        = string
}

variable "environment" {
  description = "Deployment environment used to name and tag database resources."
  type        = string
}

variable "db_subnet_ids" {
  description = "Two distinct private subnet IDs for the RDS subnet group."
  type        = list(string)

  validation {
    condition = (
      length(var.db_subnet_ids) == 2 &&
      length(toset(var.db_subnet_ids)) == 2
    )
    error_message = "db_subnet_ids must contain exactly two distinct subnet IDs."
  }
}

variable "rds_security_group_id" {
  description = "Security group ID that permits PostgreSQL traffic from application tasks."
  type        = string
}

variable "instance_class" {
  description = "RDS instance class from the Graviton T4g family."
  type        = string
  default     = "db.t4g.micro"

  validation {
    condition     = can(regex("^db\\.t4g\\.[a-z0-9]+$", var.instance_class))
    error_message = "instance_class must be in the db.t4g.* family."
  }
}

variable "allocated_storage" {
  description = "Initial gp3 storage allocation in GiB."
  type        = number
  default     = 20

  validation {
    condition     = var.allocated_storage >= 20 && var.allocated_storage <= 100
    error_message = "allocated_storage must be from 20 through 100 GiB."
  }
}

variable "database_name" {
  description = "PostgreSQL database identifier created with the instance."
  type        = string

  validation {
    condition = (
      length(var.database_name) <= 63 &&
      can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.database_name))
    )
    error_message = "database_name must be a PostgreSQL identifier no longer than 63 characters."
  }
}

variable "deletion_protection" {
  description = "Whether RDS deletion protection is enabled."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Whether deletion skips the deterministic final snapshot."
  type        = bool
  default     = false
}
