mock_provider "aws" {}

variables {
  project       = "hono-starter-kit"
  environment   = "dev"
  aws_region    = "ap-northeast-1"
  app_origin    = "https://app.example.com"
  domain_prefix = "hono-starter-kit-dev"
}

run "cognito_is_a_protected_secretless_oidc_provider" {
  command = plan

  override_resource {
    override_during = plan
    target          = aws_cognito_user_pool.app
    values = {
      id = "ap-northeast-1_testpool"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cognito_user_pool_client.app
    values = {
      id = "public-client-id"
    }
  }

  assert {
    condition = (
      aws_cognito_user_pool.app.name == "hono-starter-kit-dev" &&
      aws_cognito_user_pool.app.user_pool_tier == "ESSENTIALS" &&
      aws_cognito_user_pool.app.username_attributes == toset(["email"]) &&
      aws_cognito_user_pool.app.auto_verified_attributes == toset(["email"]) &&
      aws_cognito_user_pool.app.mfa_configuration == "OFF" &&
      aws_cognito_user_pool.app.deletion_protection == "ACTIVE"
    )
    error_message = "The dev user pool must be Essentials-tier, email-only, MFA-off, and deletion-protected."
  }

  assert {
    condition = (
      one(aws_cognito_user_pool.app.admin_create_user_config).allow_admin_create_user_only &&
      !one(aws_cognito_user_pool.app.username_configuration).case_sensitive
    )
    error_message = "Self-sign-up must be disabled and email usernames must be case-insensitive."
  }

  assert {
    condition = (
      one(aws_cognito_user_pool.app.password_policy).minimum_length == 14 &&
      one(aws_cognito_user_pool.app.password_policy).require_lowercase &&
      one(aws_cognito_user_pool.app.password_policy).require_numbers &&
      one(aws_cognito_user_pool.app.password_policy).require_symbols &&
      one(aws_cognito_user_pool.app.password_policy).require_uppercase &&
      one(aws_cognito_user_pool.app.password_policy).temporary_password_validity_days == 7
    )
    error_message = "Passwords must use the exact 14-character mixed policy and seven-day temporary lifetime."
  }

  assert {
    condition = (
      aws_cognito_user_pool_client.app.name == "hono-starter-kit-dev-web" &&
      aws_cognito_user_pool_client.app.user_pool_id == "ap-northeast-1_testpool" &&
      !aws_cognito_user_pool_client.app.generate_secret &&
      aws_cognito_user_pool_client.app.allowed_oauth_flows_user_pool_client &&
      aws_cognito_user_pool_client.app.allowed_oauth_flows == toset(["code"]) &&
      aws_cognito_user_pool_client.app.allowed_oauth_scopes == toset(["openid", "profile", "email"]) &&
      aws_cognito_user_pool_client.app.supported_identity_providers == toset(["COGNITO"])
    )
    error_message = "The public client must be secretless and allow only Cognito authorization-code OIDC."
  }

  assert {
    condition = (
      aws_cognito_user_pool_client.app.callback_urls == toset(["https://app.example.com/auth/callback"]) &&
      aws_cognito_user_pool_client.app.logout_urls == toset(["https://app.example.com/login"]) &&
      aws_cognito_user_pool_client.app.prevent_user_existence_errors == "ENABLED" &&
      aws_cognito_user_pool_client.app.enable_token_revocation
    )
    error_message = "The client must use the exact callback/logout URLs, hide user existence, and enable token revocation."
  }

  assert {
    condition = (
      aws_cognito_user_pool_domain.app.domain == "hono-starter-kit-dev" &&
      aws_cognito_user_pool_domain.app.user_pool_id == "ap-northeast-1_testpool" &&
      aws_cognito_user_pool_domain.app.managed_login_version == 2
    )
    error_message = "The standard Cognito domain must use Managed Login version 2."
  }

  assert {
    condition = (
      aws_cognito_managed_login_branding.app.user_pool_id == "ap-northeast-1_testpool" &&
      aws_cognito_managed_login_branding.app.client_id == "public-client-id" &&
      aws_cognito_managed_login_branding.app.use_cognito_provided_values
    )
    error_message = "API で作成した app client に Managed Login の既定 branding を割り当てる必要がある。"
  }

  assert {
    condition = aws_cognito_user_pool.app.tags == tomap({
      Project     = "hono-starter-kit"
      Environment = "dev"
      ManagedBy   = "Terraform"
    })
    error_message = "The taggable identity resource must carry only the exact project, environment, and management tags."
  }

  assert {
    condition = (
      output.user_pool_id == "ap-northeast-1_testpool" &&
      output.oidc_issuer == "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_testpool" &&
      output.oidc_client_id == "public-client-id" &&
      output.oidc_authorization_endpoint == "https://hono-starter-kit-dev.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize" &&
      output.oidc_logout_endpoint == "https://hono-starter-kit-dev.auth.ap-northeast-1.amazoncognito.com/logout"
    )
    error_message = "The module must expose only the provider-neutral OIDC endpoint and public-ID contract."
  }
}

run "deletion_protection_flag_is_forwarded" {
  command = plan

  variables {
    deletion_protection = false
  }

  assert {
    condition     = aws_cognito_user_pool.app.deletion_protection == "INACTIVE"
    error_message = "The deletion-protection input must map false to Cognito INACTIVE."
  }
}

run "rejects_non_dev_environment" {
  command = plan

  variables {
    environment = "prod"
  }

  expect_failures = [var.environment]
}

run "rejects_http_app_origin" {
  command = plan

  variables {
    app_origin = "http://app.example.com"
  }

  expect_failures = [var.app_origin]
}

run "rejects_app_origin_with_path" {
  command = plan

  variables {
    app_origin = "https://app.example.com/base"
  }

  expect_failures = [var.app_origin]
}

run "rejects_app_origin_with_query" {
  command = plan

  variables {
    app_origin = "https://app.example.com?mode=dev"
  }

  expect_failures = [var.app_origin]
}

run "rejects_app_origin_with_fragment" {
  command = plan

  variables {
    app_origin = "https://app.example.com#fragment"
  }

  expect_failures = [var.app_origin]
}

run "rejects_app_origin_with_credentials" {
  command = plan

  variables {
    app_origin = "https://user:password@app.example.com"
  }

  expect_failures = [var.app_origin]
}

run "rejects_uppercase_domain_prefix" {
  command = plan

  variables {
    domain_prefix = "Hono-starter-kit-dev"
  }

  expect_failures = [var.domain_prefix]
}

run "rejects_leading_hyphen_domain_prefix" {
  command = plan

  variables {
    domain_prefix = "-hono-starter-kit-dev"
  }

  expect_failures = [var.domain_prefix]
}

run "rejects_trailing_hyphen_domain_prefix" {
  command = plan

  variables {
    domain_prefix = "hono-starter-kit-dev-"
  }

  expect_failures = [var.domain_prefix]
}

run "rejects_domain_prefix_over_limit" {
  command = plan

  variables {
    domain_prefix = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [var.domain_prefix]
}
