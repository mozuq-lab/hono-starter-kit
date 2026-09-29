output "state_bucket_name" {
  description = "Name of the S3 bucket that stores Terraform state."
  value       = aws_s3_bucket.state.bucket
}

output "state_bucket_region" {
  description = "AWS region containing the Terraform state bucket."
  value       = var.aws_region
}

output "ecr_repository_name" {
  description = "Name of the API container image repository."
  value       = aws_ecr_repository.api.name
}

output "ecr_repository_url" {
  description = "URL of the API container image repository."
  value       = aws_ecr_repository.api.repository_url
}

output "ecr_repository_arn" {
  description = "ARN of the API container image repository."
  value       = aws_ecr_repository.api.arn
}

output "github_plan_role_arn" {
  description = "ARN of the repository-scoped GitHub plan role. Has a value only when create_github_plan_role = true."
  value       = one(aws_iam_role.plan[*].arn)
}

output "github_deploy_role_arn" {
  description = "ARN of the repository-scoped GitHub deploy role. Has a value only when create_github_deploy_role = true."
  value       = one(aws_iam_role.deploy[*].arn)
}
