mock_provider "aws" {}

variables {
  project                = "hono-starter-kit"
  environment            = "dev"
  vpc_id                 = "vpc-network"
  private_app_subnet_ids = ["subnet-app-a", "subnet-app-c"]
  alb_security_group_id  = "sg-alb"
  app_port               = 3000
}

run "internal_alb_exposes_only_approved_paths" {
  command = plan

  override_resource {
    override_during = plan
    target          = aws_lb.api
    values = {
      arn      = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/internal-api/1234567890abcdef"
      dns_name = "internal-api.ap-northeast-1.elb.amazonaws.com"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_lb_target_group.api
    values = {
      arn = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:targetgroup/internal-api/1234567890abcdef"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_lb_listener.http
    values = {
      arn = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:listener/app/internal-api/1234567890abcdef/abcdef1234567890"
    }
  }

  assert {
    condition = (
      aws_lb.api.name == "hono-starter-kit-dev-api" &&
      aws_lb.api.internal &&
      aws_lb.api.load_balancer_type == "application" &&
      aws_lb.api.enable_deletion_protection
    )
    error_message = "The API load balancer must be internal, application-class, and deletion-protected by default."
  }

  assert {
    condition = (
      length(aws_lb.api.subnets) == 2 &&
      aws_lb.api.subnets == toset(["subnet-app-a", "subnet-app-c"]) &&
      length(aws_lb.api.security_groups) == 1 &&
      aws_lb.api.security_groups == toset(["sg-alb"])
    )
    error_message = "The internal ALB must use exactly the two supplied private app subnets and only the supplied ALB security group."
  }

  assert {
    condition = (
      aws_lb_target_group.api.name == "hono-starter-kit-dev-api" &&
      aws_lb_target_group.api.vpc_id == "vpc-network" &&
      aws_lb_target_group.api.target_type == "ip" &&
      aws_lb_target_group.api.port == 3000 &&
      aws_lb_target_group.api.protocol == "HTTP"
    )
    error_message = "The target group must register IP targets on the application HTTP port in the supplied VPC."
  }

  assert {
    condition = (
      one(aws_lb_target_group.api.health_check).path == "/healthz" &&
      one(aws_lb_target_group.api.health_check).matcher == "200" &&
      one(aws_lb_target_group.api.health_check).interval == 30 &&
      one(aws_lb_target_group.api.health_check).timeout == 5 &&
      one(aws_lb_target_group.api.health_check).healthy_threshold == 2 &&
      one(aws_lb_target_group.api.health_check).unhealthy_threshold == 2
    )
    error_message = "The target group health check must use the exact /healthz timing, matcher, and threshold contract."
  }

  assert {
    condition = (
      aws_lb_listener.http.load_balancer_arn == aws_lb.api.arn &&
      aws_lb_listener.http.port == 80 &&
      aws_lb_listener.http.protocol == "HTTP" &&
      length(aws_lb_listener.http.default_action) == 1 &&
      one(aws_lb_listener.http.default_action).type == "fixed-response" &&
      one(one(aws_lb_listener.http.default_action).fixed_response).status_code == "503"
    )
    error_message = "The sole HTTP listener must return a fixed 503 response by default."
  }

  assert {
    condition = (
      aws_lb_listener_rule.api.listener_arn == aws_lb_listener.http.arn &&
      length(aws_lb_listener_rule.api.action) == 1 &&
      one(aws_lb_listener_rule.api.action).type == "forward" &&
      one(aws_lb_listener_rule.api.action).target_group_arn == aws_lb_target_group.api.arn &&
      length(aws_lb_listener_rule.api.condition) == 1 &&
      length(one(one(aws_lb_listener_rule.api.condition).path_pattern).values) == 4 &&
      toset(one(one(aws_lb_listener_rule.api.condition).path_pattern).values) == toset([
        "/api",
        "/api/*",
        "/auth",
        "/auth/*",
      ])
    )
    error_message = "One listener rule must forward exactly the approved API and Auth path patterns."
  }

  assert {
    condition = (
      aws_lb.api.tags == tomap({
        Project     = "hono-starter-kit"
        Environment = "dev"
        ManagedBy   = "Terraform"
      }) &&
      aws_lb_target_group.api.tags == aws_lb.api.tags &&
      aws_lb_listener.http.tags == aws_lb.api.tags &&
      aws_lb_listener_rule.api.tags == aws_lb.api.tags
    )
    error_message = "Every ingress resource must carry only the exact project, environment, and management tags."
  }

  assert {
    condition = (
      output.alb_arn == "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/internal-api/1234567890abcdef" &&
      output.alb_dns_name == "internal-api.ap-northeast-1.elb.amazonaws.com" &&
      output.listener_arn == "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:listener/app/internal-api/1234567890abcdef/abcdef1234567890" &&
      output.target_group_arn == "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:targetgroup/internal-api/1234567890abcdef"
    )
    error_message = "The module must expose only the private ALB, listener, and target-group interface."
  }
}

run "deletion_protection_flag_is_forwarded" {
  command = plan

  variables {
    deletion_protection = false
  }

  assert {
    condition     = !aws_lb.api.enable_deletion_protection
    error_message = "The deletion-protection input must be forwarded to the internal ALB."
  }
}

run "rejects_one_private_app_subnet" {
  command = plan

  variables {
    private_app_subnet_ids = ["subnet-app-a"]
  }

  expect_failures = [var.private_app_subnet_ids]
}

run "rejects_three_private_app_subnets" {
  command = plan

  variables {
    private_app_subnet_ids = ["subnet-app-a", "subnet-app-c", "subnet-app-d"]
  }

  expect_failures = [var.private_app_subnet_ids]
}

run "rejects_duplicate_private_app_subnets" {
  command = plan

  variables {
    private_app_subnet_ids = ["subnet-app-a", "subnet-app-a"]
  }

  expect_failures = [var.private_app_subnet_ids]
}

run "rejects_app_port_below_range" {
  command = plan

  variables {
    app_port = 0
  }

  expect_failures = [var.app_port]
}

run "rejects_app_port_above_range" {
  command = plan

  variables {
    app_port = 65536
  }

  expect_failures = [var.app_port]
}
