output "migration_log_group_name" {
  description = "CloudWatch log group name for one-off database migration tasks."
  value       = aws_cloudwatch_log_group.migration.name
}

output "api_log_group_name" {
  description = "CloudWatch log group name for API container logs."
  value       = aws_cloudwatch_log_group.api.name
}

output "adot_log_group_name" {
  description = "CloudWatch log group name for ADOT collector logs."
  value       = aws_cloudwatch_log_group.adot.name
}

output "task_execution_role_arn" {
  description = "ARN of the ECS task execution role."
  value       = aws_iam_role.task_execution.arn
}

output "runtime_task_role_arn" {
  description = "ARN of the ECS runtime task role."
  value       = aws_iam_role.runtime_task.arn
}

output "cluster_name" {
  description = "Name of the ECS application cluster."
  value       = aws_ecs_cluster.app.name
}

output "cluster_arn" {
  description = "ARN of the ECS application cluster."
  value       = aws_ecs_cluster.app.arn
}

output "service_name" {
  description = "Name of the ECS application service."
  value       = aws_ecs_service.app.name
}

output "service_arn" {
  description = "ARN of the ECS application service."
  value       = aws_ecs_service.app.id
}

output "task_definition_arn" {
  description = "ARN of the ECS application task definition."
  value       = aws_ecs_task_definition.app.arn
}
