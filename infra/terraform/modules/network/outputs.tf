output "vpc_id" {
  description = "ID of the module VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs ordered by availability_zones."
  value       = [for index in range(length(var.availability_zones)) : aws_subnet.public[index].id]
}

output "private_app_subnet_ids" {
  description = "Private application subnet IDs ordered by availability_zones."
  value       = [for index in range(length(var.availability_zones)) : aws_subnet.app[index].id]
}

output "private_db_subnet_ids" {
  description = "Private database subnet IDs ordered by availability_zones."
  value       = [for index in range(length(var.availability_zones)) : aws_subnet.db[index].id]
}

output "alb_security_group_id" {
  description = "ID of the CloudFront-facing ALB security group."
  value       = aws_security_group.alb.id
}

output "task_security_group_id" {
  description = "ID of the application task security group."
  value       = aws_security_group.task.id
}

output "rds_security_group_id" {
  description = "ID of the PostgreSQL security group."
  value       = aws_security_group.rds.id
}
