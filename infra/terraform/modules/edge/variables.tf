variable "project" {
  description = "Project name used to name and tag edge resources."
  type        = string
}

variable "environment" {
  description = "Deployment environment used to name and tag edge resources."
  type        = string
}

variable "alb_arn" {
  description = "ARN of the internal application load balancer used by the CloudFront VPC origin."
  type        = string
}

variable "alb_dns_name" {
  description = "Private DNS name of the internal application load balancer used by the CloudFront API origin."
  type        = string
}

variable "force_destroy" {
  description = "Whether destroying the web bucket may delete remaining objects and versions."
  type        = bool
  default     = false
}
