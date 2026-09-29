output "vpc_id" {
  description = "ID of the development VPC."
  value       = module.network.vpc_id
}

output "private_app_subnet_ids" {
  description = "Private application subnet IDs ordered by selected availability zone."
  value       = module.network.private_app_subnet_ids
}

output "task_security_group_id" {
  description = "Security group ID reserved for future application tasks."
  value       = module.network.task_security_group_id
}

output "target_group_arn" {
  description = "ARN of the internal application target group."
  value       = module.ingress.target_group_arn
}

output "database_endpoint" {
  description = "Private PostgreSQL hostname."
  value       = module.data.database_endpoint
}

output "database_port" {
  description = "PostgreSQL listener port."
  value       = module.data.database_port
}

output "database_name" {
  description = "PostgreSQL database name."
  value       = module.data.database_name
}

output "database_secret_arn" {
  description = "ARN metadata for the RDS-managed master-user secret."
  value       = module.data.database_secret_arn
  sensitive   = true
}

output "web_bucket_name" {
  description = "Name of the private bucket that stores SPA assets."
  value       = module.edge.web_bucket_name
}

output "distribution_id" {
  description = "ID of the CloudFront application distribution."
  value       = module.edge.distribution_id
}

output "app_origin" {
  description = "HTTPS origin of the application on its default CloudFront domain."
  value       = module.edge.app_origin
}

output "oidc_issuer" {
  description = "OIDC issuer URL for the application identity provider."
  value       = module.identity.oidc_issuer
}

output "oidc_client_id" {
  description = "Public OIDC client ID for the application."
  value       = module.identity.oidc_client_id
}

output "oidc_authorization_endpoint" {
  description = "OIDC authorization endpoint for the application."
  value       = module.identity.oidc_authorization_endpoint
}

output "oidc_logout_endpoint" {
  description = "OIDC logout endpoint for the application."
  value       = module.identity.oidc_logout_endpoint
}

output "migration_log_group_name" {
  description = "CloudWatch log group name for one-off database migration tasks."
  value       = module.workload.migration_log_group_name
}

output "api_log_group_name" {
  description = "CloudWatch log group name for API container logs."
  value       = module.workload.api_log_group_name
}

output "adot_log_group_name" {
  description = "CloudWatch log group name for ADOT collector logs."
  value       = module.workload.adot_log_group_name
}

output "task_execution_role_arn" {
  description = "ARN of the ECS task execution role."
  value       = module.workload.task_execution_role_arn
}

output "runtime_task_role_arn" {
  description = "ARN of the ECS runtime task role."
  value       = module.workload.runtime_task_role_arn
}

output "cluster_name" {
  description = "Name of the ECS application cluster."
  value       = module.workload.cluster_name
}

output "cluster_arn" {
  description = "ARN of the ECS application cluster."
  value       = module.workload.cluster_arn
}

output "service_name" {
  description = "Name of the ECS application service."
  value       = module.workload.service_name
}

output "service_arn" {
  description = "ARN of the ECS application service."
  value       = module.workload.service_arn
}

output "task_definition_arn" {
  description = "ARN of the ECS application task definition."
  value       = module.workload.task_definition_arn
}
