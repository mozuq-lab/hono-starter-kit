output "web_bucket_name" {
  description = "Name of the private bucket that stores SPA assets."
  value       = aws_s3_bucket.web.bucket
}

output "distribution_id" {
  description = "ID of the CloudFront application distribution."
  value       = aws_cloudfront_distribution.app.id
}

output "distribution_arn" {
  description = "ARN of the CloudFront application distribution."
  value       = aws_cloudfront_distribution.app.arn
}

output "distribution_domain_name" {
  description = "Default CloudFront domain name for the application."
  value       = aws_cloudfront_distribution.app.domain_name
}

output "app_origin" {
  description = "HTTPS origin of the application on its default CloudFront domain."
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}

output "web_bucket_force_destroy_effective" {
  description = "Resolved force_destroy for the web bucket, for mock test assertions."
  value       = aws_s3_bucket.web.force_destroy
}
