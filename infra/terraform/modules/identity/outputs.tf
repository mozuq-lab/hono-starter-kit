output "user_pool_id" {
  description = "Cognito user pool ID."
  value       = aws_cognito_user_pool.app.id
}

output "oidc_issuer" {
  description = "OIDC issuer URL."
  value       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.app.id}"
}

output "oidc_client_id" {
  description = "Public OIDC client ID."
  value       = aws_cognito_user_pool_client.app.id
}

output "oidc_authorization_endpoint" {
  description = "OIDC authorization endpoint."
  value       = "https://${var.domain_prefix}.auth.${var.aws_region}.amazoncognito.com/oauth2/authorize"
}

output "oidc_logout_endpoint" {
  description = "OIDC logout endpoint."
  value       = "https://${var.domain_prefix}.auth.${var.aws_region}.amazoncognito.com/logout"
}
