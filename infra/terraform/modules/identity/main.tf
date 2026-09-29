locals {
  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

resource "aws_cognito_user_pool" "app" {
  name                     = "${var.project}-${var.environment}"
  user_pool_tier           = "ESSENTIALS"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"
  deletion_protection      = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  username_configuration {
    case_sensitive = false
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  tags = local.common_tags
}

resource "aws_cognito_user_pool_client" "app" {
  name         = "${var.project}-${var.environment}-web"
  user_pool_id = aws_cognito_user_pool.app.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "profile", "email"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${var.app_origin}/auth/callback"]
  logout_urls                          = ["${var.app_origin}/login"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
}

resource "aws_cognito_user_pool_domain" "app" {
  domain                = var.domain_prefix
  user_pool_id          = aws_cognito_user_pool.app.id
  managed_login_version = 2
}

// API で作成した client は branding を明示的に割り当てるまで Managed Login を利用できない。
resource "aws_cognito_managed_login_branding" "app" {
  user_pool_id                = aws_cognito_user_pool.app.id
  client_id                   = aws_cognito_user_pool_client.app.id
  use_cognito_provided_values = true
}
