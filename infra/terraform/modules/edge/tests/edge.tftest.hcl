mock_provider "aws" {}

variables {
  project      = "hono-starter-kit"
  environment  = "dev"
  alb_arn      = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/internal-api/1234567890abcdef"
  alb_dns_name = "internal-api.ap-northeast-1.elb.amazonaws.com"
}

run "private_spa_and_exact_api_routing" {
  command = plan

  override_resource {
    override_during = plan
    target          = aws_s3_bucket.web
    values = {
      arn                         = "arn:aws:s3:::hono-starter-kit-dev-web"
      id                          = "hono-starter-kit-dev-web"
      bucket_regional_domain_name = "hono-starter-kit-dev-web.s3.ap-northeast-1.amazonaws.com"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cloudfront_origin_access_control.web
    values = {
      id = "web-origin-access-control-id"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cloudfront_vpc_origin.api
    values = {
      arn = "arn:aws:cloudfront::123456789012:vpcorigin/api-origin"
      id  = "api-vpc-origin-id"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cloudfront_function.spa
    values = {
      arn = "arn:aws:cloudfront::123456789012:function/hono-starter-kit-dev-spa"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cloudfront_cache_policy.spa
    values = {
      id = "spa-cache-policy-id"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cloudfront_response_headers_policy.security
    values = {
      id = "security-response-policy-id"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_cloudfront_distribution.app
    values = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/EDGE123"
      domain_name = "d111111abcdef8.cloudfront.net"
      id          = "EDGE123"
    }
  }

  assert {
    condition = (
      aws_s3_bucket.web.bucket == "hono-starter-kit-dev-web" &&
      !aws_s3_bucket.web.force_destroy &&
      one(aws_s3_bucket_ownership_controls.web.rule).object_ownership == "BucketOwnerEnforced" &&
      one(aws_s3_bucket_versioning.web.versioning_configuration).status == "Enabled"
    )
    error_message = "The SPA bucket must be named deterministically, owner-enforced, versioned, and protected from force deletion."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.web.block_public_acls &&
      aws_s3_bucket_public_access_block.web.block_public_policy &&
      aws_s3_bucket_public_access_block.web.ignore_public_acls &&
      aws_s3_bucket_public_access_block.web.restrict_public_buckets
    )
    error_message = "Every S3 public-access control must remain enabled."
  }

  assert {
    condition = (
      aws_cloudfront_origin_access_control.web.name == "hono-starter-kit-dev-web" &&
      aws_cloudfront_origin_access_control.web.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.web.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.web.signing_protocol == "sigv4"
    )
    error_message = "The SPA origin must use always-signed SigV4 S3 origin access control."
  }

  assert {
    condition = (
      aws_s3_bucket_policy.web.bucket == "hono-starter-kit-dev-web" &&
      jsondecode(aws_s3_bucket_policy.web.policy).Version == "2012-10-17" &&
      length(jsondecode(aws_s3_bucket_policy.web.policy).Statement) == 1 &&
      one(jsondecode(aws_s3_bucket_policy.web.policy).Statement).Effect == "Allow" &&
      one(jsondecode(aws_s3_bucket_policy.web.policy).Statement).Principal.Service == "cloudfront.amazonaws.com" &&
      one(jsondecode(aws_s3_bucket_policy.web.policy).Statement).Action == "s3:GetObject" &&
      one(jsondecode(aws_s3_bucket_policy.web.policy).Statement).Resource == "arn:aws:s3:::hono-starter-kit-dev-web/*" &&
      one(jsondecode(aws_s3_bucket_policy.web.policy).Statement).Condition.StringEquals["AWS:SourceArn"] == "arn:aws:cloudfront::123456789012:distribution/EDGE123"
    )
    error_message = "The bucket policy must grant only distribution-scoped CloudFront GetObject access to web objects."
  }

  assert {
    condition = (
      one(aws_cloudfront_vpc_origin.api.vpc_origin_endpoint_config).name == "hono-starter-kit-dev-api" &&
      one(aws_cloudfront_vpc_origin.api.vpc_origin_endpoint_config).arn == var.alb_arn &&
      one(aws_cloudfront_vpc_origin.api.vpc_origin_endpoint_config).http_port == 80 &&
      one(aws_cloudfront_vpc_origin.api.vpc_origin_endpoint_config).https_port == 443 &&
      one(aws_cloudfront_vpc_origin.api.vpc_origin_endpoint_config).origin_protocol_policy == "http-only" &&
      toset(one(one(aws_cloudfront_vpc_origin.api.vpc_origin_endpoint_config).origin_ssl_protocols).items) == toset(["TLSv1.2"]) &&
      one(one(aws_cloudfront_vpc_origin.api.vpc_origin_endpoint_config).origin_ssl_protocols).quantity == 1
    )
    error_message = "The sole VPC origin must terminate at the supplied internal ALB over the explicit HTTP boundary."
  }

  assert {
    condition = (
      length(aws_cloudfront_distribution.app.origin) == 2 &&
      one([
        for origin in aws_cloudfront_distribution.app.origin : origin
        if origin.origin_id == "web"
      ]).domain_name == "hono-starter-kit-dev-web.s3.ap-northeast-1.amazonaws.com" &&
      one([
        for origin in aws_cloudfront_distribution.app.origin : origin
        if origin.origin_id == "web"
      ]).origin_access_control_id == "web-origin-access-control-id" &&
      one([
        for origin in aws_cloudfront_distribution.app.origin : origin
        if origin.origin_id == "api"
      ]).domain_name == var.alb_dns_name &&
      one(one([
        for origin in aws_cloudfront_distribution.app.origin : origin
        if origin.origin_id == "api"
      ]).vpc_origin_config).vpc_origin_id == "api-vpc-origin-id" &&
      length([
        for origin in aws_cloudfront_distribution.app.origin : origin
        if length(origin.vpc_origin_config) == 1
      ]) == 1
    )
    error_message = "The distribution must contain only the private S3 OAC origin and one internal-ALB VPC origin."
  }

  assert {
    condition = (
      aws_cloudfront_cache_policy.spa.name == "hono-starter-kit-dev-spa" &&
      aws_cloudfront_cache_policy.spa.min_ttl == 0 &&
      aws_cloudfront_cache_policy.spa.default_ttl == 0 &&
      aws_cloudfront_cache_policy.spa.max_ttl == 31536000 &&
      one(aws_cloudfront_cache_policy.spa.parameters_in_cache_key_and_forwarded_to_origin).enable_accept_encoding_brotli &&
      one(aws_cloudfront_cache_policy.spa.parameters_in_cache_key_and_forwarded_to_origin).enable_accept_encoding_gzip &&
      one(one(aws_cloudfront_cache_policy.spa.parameters_in_cache_key_and_forwarded_to_origin).cookies_config).cookie_behavior == "none" &&
      one(one(aws_cloudfront_cache_policy.spa.parameters_in_cache_key_and_forwarded_to_origin).headers_config).header_behavior == "none" &&
      one(one(aws_cloudfront_cache_policy.spa.parameters_in_cache_key_and_forwarded_to_origin).query_strings_config).query_string_behavior == "none"
    )
    error_message = "The SPA cache policy must disable default caching and request forwarding while bounding origin-selected cache lifetimes."
  }

  assert {
    condition = (
      aws_cloudfront_function.spa.name == "hono-starter-kit-dev-spa" &&
      aws_cloudfront_function.spa.runtime == "cloudfront-js-2.0" &&
      aws_cloudfront_function.spa.publish &&
      length(one(aws_cloudfront_distribution.app.default_cache_behavior).function_association) == 1 &&
      one(one(aws_cloudfront_distribution.app.default_cache_behavior).function_association).event_type == "viewer-request" &&
      one(one(aws_cloudfront_distribution.app.default_cache_behavior).function_association).function_arn == "arn:aws:cloudfront::123456789012:function/hono-starter-kit-dev-spa" &&
      alltrue([
        for behavior in aws_cloudfront_distribution.app.ordered_cache_behavior :
        length(behavior.function_association) == 0
      ])
    )
    error_message = "The published SPA rewrite must run only on the default S3 viewer-request behavior."
  }

  assert {
    condition = (
      one(aws_cloudfront_distribution.app.default_cache_behavior).target_origin_id == "web" &&
      one(aws_cloudfront_distribution.app.default_cache_behavior).viewer_protocol_policy == "redirect-to-https" &&
      one(aws_cloudfront_distribution.app.default_cache_behavior).allowed_methods == toset(["GET", "HEAD"]) &&
      one(aws_cloudfront_distribution.app.default_cache_behavior).cached_methods == toset(["GET", "HEAD"]) &&
      one(aws_cloudfront_distribution.app.default_cache_behavior).cache_policy_id == "spa-cache-policy-id" &&
      one(aws_cloudfront_distribution.app.default_cache_behavior).response_headers_policy_id == "security-response-policy-id" &&
      one(aws_cloudfront_distribution.app.default_cache_behavior).compress
    )
    error_message = "The default behavior must redirect to HTTPS and serve compressed SPA reads through the custom cache and security policies."
  }

  assert {
    condition = (
      length(aws_cloudfront_distribution.app.ordered_cache_behavior) == 4 &&
      [for behavior in aws_cloudfront_distribution.app.ordered_cache_behavior : behavior.path_pattern] == [
        "/api",
        "/api/*",
        "/auth",
        "/auth/*",
      ] &&
      alltrue([
        for behavior in aws_cloudfront_distribution.app.ordered_cache_behavior :
        behavior.target_origin_id == "api" &&
        behavior.viewer_protocol_policy == "redirect-to-https" &&
        behavior.allowed_methods == toset(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]) &&
        behavior.cached_methods == toset(["GET", "HEAD"]) &&
        behavior.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" &&
        behavior.origin_request_policy_id == "b689b0a8-53d0-40ab-baf2-68738e2966ac" &&
        behavior.response_headers_policy_id == "security-response-policy-id" &&
        behavior.compress
      ])
    )
    error_message = "Exactly four ordered API/Auth behaviors must forward all methods without caching or forwarding the viewer Host header."
  }

  assert {
    condition = (
      aws_cloudfront_distribution.app.enabled &&
      aws_cloudfront_distribution.app.default_root_object == "index.html" &&
      aws_cloudfront_distribution.app.price_class == "PriceClass_100" &&
      try(length(aws_cloudfront_distribution.app.aliases), 0) == 0 &&
      one(aws_cloudfront_distribution.app.viewer_certificate).cloudfront_default_certificate &&
      one(one(aws_cloudfront_distribution.app.restrictions).geo_restriction).restriction_type == "none"
    )
    error_message = "The app must use only the default CloudFront domain and certificate with the exact root object and dev price class."
  }

  assert {
    condition = (
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).strict_transport_security).access_control_max_age_sec == 31536000 &&
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).strict_transport_security).include_subdomains &&
      !one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).strict_transport_security).preload &&
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).strict_transport_security).override &&
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).content_type_options).override &&
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).frame_options).frame_option == "DENY" &&
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).frame_options).override &&
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).referrer_policy).referrer_policy == "strict-origin-when-cross-origin" &&
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).referrer_policy).override
    )
    error_message = "The response policy must enforce the exact HSTS, nosniff, frame-deny, and referrer protections."
  }

  assert {
    condition = (
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).content_security_policy).content_security_policy == "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; form-action 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'" &&
      one(one(aws_cloudfront_response_headers_policy.security.security_headers_config).content_security_policy).override
    )
    error_message = "The response policy must override the origin with the exact restrictive CSP."
  }

  assert {
    condition = (
      aws_s3_bucket.web.tags == tomap({
        Project     = "hono-starter-kit"
        Environment = "dev"
        ManagedBy   = "Terraform"
      }) &&
      aws_cloudfront_vpc_origin.api.tags == aws_s3_bucket.web.tags &&
      aws_cloudfront_function.spa.tags == aws_s3_bucket.web.tags &&
      aws_cloudfront_distribution.app.tags == aws_s3_bucket.web.tags
    )
    error_message = "Every taggable edge resource must carry only the exact project, environment, and management tags."
  }

  assert {
    condition = (
      output.web_bucket_name == "hono-starter-kit-dev-web" &&
      output.distribution_id == "EDGE123" &&
      output.distribution_arn == "arn:aws:cloudfront::123456789012:distribution/EDGE123" &&
      output.distribution_domain_name == "d111111abcdef8.cloudfront.net" &&
      output.app_origin == "https://d111111abcdef8.cloudfront.net"
    )
    error_message = "The module must expose only private-bucket and default-CloudFront distribution metadata."
  }
}
