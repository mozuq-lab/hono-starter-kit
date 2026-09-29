output "database_endpoint" {
  description = "Private PostgreSQL hostname."
  value       = aws_db_instance.postgres.address
}

output "database_port" {
  description = "PostgreSQL listener port."
  value       = aws_db_instance.postgres.port
}

output "database_name" {
  description = "PostgreSQL database name."
  value       = aws_db_instance.postgres.db_name
}

output "database_secret_arn" {
  description = "ARN metadata for the RDS-managed master-user secret."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
  sensitive   = true
}

output "deletion_protection_effective" {
  description = "Resolved deletion protection for the database, for mock test assertions."
  value       = aws_db_instance.postgres.deletion_protection
}

output "skip_final_snapshot_effective" {
  description = "Resolved final-snapshot behavior for the database, for mock test assertions."
  value       = aws_db_instance.postgres.skip_final_snapshot
}
