data "aws_caller_identity" "current" {}

locals {
  state_bucket_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.state.arn,
          "${aws_s3_bucket.state.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })

  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after seven days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Retain the latest 20 release images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["release-"]
          countType     = "imageCountMoreThan"
          countNumber   = 20
        }
        action = {
          type = "expire"
        }
      },
    ]
  })
}

locals {
  github_oidc_provider_mode_is_valid = (
    var.create_github_oidc_provider && var.github_oidc_provider_arn == null
    ) || (
    !var.create_github_oidc_provider && var.github_oidc_provider_arn != null
  )
}

check "github_oidc_provider_mode" {
  assert {
    condition     = local.github_oidc_provider_mode_is_valid
    error_message = "Create the GitHub OIDC provider or supply its ARN, but not both."
  }
}

locals {
  create_github_roles      = var.create_github_plan_role || var.create_github_deploy_role
  github_oidc_provider_arn = var.create_github_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : var.github_oidc_provider_arn
  plan_subject             = "repo:${var.github_owner}/${var.github_repository}:ref:refs/heads/${var.github_default_branch}"
  deploy_subject           = "repo:${var.github_owner}/${var.github_repository}:environment:${var.environment}"

  plan_trust_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = local.plan_subject
      } }
    }]
  })

  deploy_trust_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = local.deploy_subject
      } }
    }]
  })

  state_key                   = "${var.project}/${var.environment}/terraform.tfstate"
  state_lock_key              = "${local.state_key}.tflock"
  state_bucket_actions        = ["s3:GetBucketLocation", "s3:ListBucket"]
  plan_state_object_actions   = ["s3:GetObject"]
  deploy_state_object_actions = ["s3:GetObject", "s3:PutObject"]
  state_lock_actions          = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]

  plan_state_access_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StateBucket"
        Effect   = "Allow"
        Action   = local.state_bucket_actions
        Resource = aws_s3_bucket.state.arn
      },
      {
        Sid      = "StateObjectRead"
        Effect   = "Allow"
        Action   = local.plan_state_object_actions
        Resource = "${aws_s3_bucket.state.arn}/${local.state_key}"
      },
      {
        Sid      = "StateLock"
        Effect   = "Allow"
        Action   = local.state_lock_actions
        Resource = "${aws_s3_bucket.state.arn}/${local.state_lock_key}"
      },
    ]
  })

  deploy_state_access_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StateBucket"
        Effect   = "Allow"
        Action   = local.state_bucket_actions
        Resource = aws_s3_bucket.state.arn
      },
      {
        Sid      = "StateObject"
        Effect   = "Allow"
        Action   = local.deploy_state_object_actions
        Resource = "${aws_s3_bucket.state.arn}/${local.state_key}"
      },
      {
        Sid      = "StateLock"
        Effect   = "Allow"
        Action   = local.state_lock_actions
        Resource = "${aws_s3_bucket.state.arn}/${local.state_lock_key}"
      },
    ]
  })

  deploy_foundation_actions = [
    "ec2:AllocateAddress",
    "ec2:AssociateRouteTable",
    "ec2:AttachInternetGateway",
    "ec2:AuthorizeSecurityGroupEgress",
    "ec2:AuthorizeSecurityGroupIngress",
    "ec2:CreateInternetGateway",
    "ec2:CreateNatGateway",
    "ec2:CreateRoute",
    "ec2:CreateRouteTable",
    "ec2:CreateSecurityGroup",
    "ec2:CreateSubnet",
    "ec2:CreateTags",
    "ec2:CreateVpc",
    "ec2:DeleteInternetGateway",
    "ec2:DeleteNatGateway",
    "ec2:DeleteRoute",
    "ec2:DeleteRouteTable",
    "ec2:DeleteSecurityGroup",
    "ec2:DeleteSubnet",
    "ec2:DeleteTags",
    "ec2:DeleteVpc",
    "ec2:DetachInternetGateway",
    "ec2:DisassociateRouteTable",
    "ec2:ModifySubnetAttribute",
    "ec2:ModifyVpcAttribute",
    "ec2:ReleaseAddress",
    "ec2:ReplaceRouteTableAssociation",
    "ec2:RevokeSecurityGroupEgress",
    "ec2:RevokeSecurityGroupIngress",
    "rds:AddTagsToResource",
    "rds:CreateDBInstance",
    "rds:CreateDBParameterGroup",
    "rds:CreateDBSubnetGroup",
    "rds:DeleteDBInstance",
    "rds:DeleteDBParameterGroup",
    "rds:DeleteDBSubnetGroup",
    "rds:ModifyDBInstance",
    "rds:ModifyDBParameterGroup",
    "rds:ModifyDBSubnetGroup",
    "rds:RemoveTagsFromResource",
    "elasticloadbalancing:AddTags",
    "elasticloadbalancing:CreateListener",
    "elasticloadbalancing:CreateLoadBalancer",
    "elasticloadbalancing:CreateRule",
    "elasticloadbalancing:CreateTargetGroup",
    "elasticloadbalancing:DeleteListener",
    "elasticloadbalancing:DeleteLoadBalancer",
    "elasticloadbalancing:DeleteRule",
    "elasticloadbalancing:DeleteTargetGroup",
    "elasticloadbalancing:ModifyListener",
    "elasticloadbalancing:ModifyLoadBalancerAttributes",
    "elasticloadbalancing:ModifyRule",
    "elasticloadbalancing:ModifyTargetGroup",
    "elasticloadbalancing:ModifyTargetGroupAttributes",
    "elasticloadbalancing:RemoveTags",
    "elasticloadbalancing:SetSecurityGroups",
    "elasticloadbalancing:SetSubnets",
    "cloudfront:CreateCachePolicy",
    "cloudfront:CreateDistribution",
    "cloudfront:CreateFunction",
    "cloudfront:CreateOriginAccessControl",
    "cloudfront:CreateResponseHeadersPolicy",
    "cloudfront:CreateVpcOrigin",
    "cloudfront:DeleteCachePolicy",
    "cloudfront:DeleteDistribution",
    "cloudfront:DeleteFunction",
    "cloudfront:DeleteOriginAccessControl",
    "cloudfront:DeleteResponseHeadersPolicy",
    "cloudfront:DeleteVpcOrigin",
    "cloudfront:PublishFunction",
    "cloudfront:TagResource",
    "cloudfront:UntagResource",
    "cloudfront:UpdateCachePolicy",
    "cloudfront:UpdateDistribution",
    "cloudfront:UpdateFunction",
    "cloudfront:UpdateOriginAccessControl",
    "cloudfront:UpdateResponseHeadersPolicy",
    "cloudfront:UpdateVpcOrigin",
    "s3:CreateBucket",
    "s3:DeleteBucket",
    "s3:DeleteBucketPolicy",
    "s3:DeleteBucketPublicAccessBlock",
    "s3:PutBucketOwnershipControls",
    "s3:PutBucketPolicy",
    "s3:PutBucketPublicAccessBlock",
    "s3:PutBucketTagging",
    "s3:PutBucketVersioning",
    "s3:PutEncryptionConfiguration",
    "cognito-idp:CreateUserPool",
    "cognito-idp:CreateUserPoolClient",
    "cognito-idp:CreateUserPoolDomain",
    "cognito-idp:CreateManagedLoginBranding",
    "cognito-idp:DeleteManagedLoginBranding",
    "cognito-idp:DeleteUserPool",
    "cognito-idp:DeleteUserPoolClient",
    "cognito-idp:DeleteUserPoolDomain",
    "cognito-idp:TagResource",
    "cognito-idp:UntagResource",
    "cognito-idp:UpdateUserPool",
    "cognito-idp:UpdateUserPoolClient",
    "cognito-idp:UpdateManagedLoginBranding",
  ]

  foundation_ec2_read_actions = [
    "ec2:DescribeAddresses",
    "ec2:DescribeAvailabilityZones",
    "ec2:DescribeInternetGateways",
    "ec2:DescribeManagedPrefixLists",
    "ec2:DescribeNatGateways",
    "ec2:DescribeNetworkInterfaces",
    "ec2:DescribeRouteTables",
    "ec2:DescribeSecurityGroupRules",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeSubnets",
    "ec2:DescribeTags",
    "ec2:DescribeVpcs",
  ]
  foundation_ec2_vpc_read_actions = [
    "ec2:DescribeVpcAttribute",
  ]
  foundation_ec2_managed_prefix_list_read_actions = [
    "ec2:GetManagedPrefixListEntries",
  ]
  foundation_rds_database_read_actions = [
    "rds:DescribeDBInstances",
  ]
  foundation_rds_parameter_group_read_actions = [
    "rds:DescribeDBParameterGroups",
    "rds:DescribeDBParameters",
  ]
  foundation_rds_subnet_group_read_actions = [
    "rds:DescribeDBSubnetGroups",
  ]
  foundation_rds_tag_read_actions = [
    "rds:ListTagsForResource",
  ]
  foundation_load_balancing_read_actions = [
    "elasticloadbalancing:DescribeListeners",
    "elasticloadbalancing:DescribeLoadBalancerAttributes",
    "elasticloadbalancing:DescribeLoadBalancers",
    "elasticloadbalancing:DescribeRules",
    "elasticloadbalancing:DescribeTags",
    "elasticloadbalancing:DescribeTargetGroupAttributes",
    "elasticloadbalancing:DescribeTargetGroups",
  ]
  foundation_cloudfront_scoped_read_actions = [
    "cloudfront:DescribeFunction",
    "cloudfront:GetCachePolicy",
    "cloudfront:GetDistribution",
    "cloudfront:GetDistributionConfig",
    "cloudfront:GetFunction",
    "cloudfront:GetOriginAccessControl",
    "cloudfront:GetResponseHeadersPolicy",
    "cloudfront:GetVpcOrigin",
    "cloudfront:ListTagsForResource",
  ]
  foundation_cloudfront_global_read_actions = [
    "cloudfront:ListCachePolicies",
    "cloudfront:ListDistributions",
    "cloudfront:ListFunctions",
    "cloudfront:ListOriginAccessControls",
    "cloudfront:ListResponseHeadersPolicies",
    "cloudfront:ListVpcOrigins",
  ]
  foundation_s3_bucket_read_actions = [
    "s3:GetBucketLocation",
    "s3:GetBucketOwnershipControls",
    "s3:GetBucketPolicy",
    "s3:GetBucketPublicAccessBlock",
    "s3:GetBucketTagging",
    "s3:GetBucketVersioning",
    "s3:GetEncryptionConfiguration",
    "s3:ListBucket",
  ]
  foundation_cognito_scoped_read_actions = [
    "cognito-idp:DescribeManagedLoginBranding",
    "cognito-idp:DescribeManagedLoginBrandingByClient",
    "cognito-idp:DescribeUserPool",
    "cognito-idp:DescribeUserPoolClient",
    "cognito-idp:GetUserPoolMfaConfig",
    "cognito-idp:ListTagsForResource",
    "cognito-idp:ListUserPoolClients",
  ]
  foundation_cognito_global_read_actions = [
    "cognito-idp:DescribeUserPoolDomain",
  ]

  ec2_create_actions = [
    "ec2:AllocateAddress",
    "ec2:CreateInternetGateway",
    "ec2:CreateNatGateway",
    "ec2:CreateRouteTable",
    "ec2:CreateSecurityGroup",
    "ec2:CreateSubnet",
    "ec2:CreateVpc",
  ]
  ec2_tag_on_create_actions = [
    "ec2:CreateTags",
  ]
  ec2_tag_on_create_operations = [
    "AllocateAddress",
    "CreateInternetGateway",
    "CreateNatGateway",
    "CreateRouteTable",
    "CreateSecurityGroup",
    "CreateSubnet",
    "CreateVpc",
  ]
  ec2_existing_tag_actions = [
    "ec2:CreateTags",
    "ec2:DeleteTags",
  ]
  rds_create_actions = [
    "rds:AddTagsToResource",
    "rds:CreateDBInstance",
    "rds:CreateDBParameterGroup",
    "rds:CreateDBSubnetGroup",
  ]
  load_balancing_create_actions = [
    "elasticloadbalancing:AddTags",
    "elasticloadbalancing:CreateLoadBalancer",
    "elasticloadbalancing:CreateTargetGroup",
  ]
  cloudfront_tagged_create_actions = [
    "cloudfront:CreateDistribution",
    "cloudfront:CreateFunction",
    "cloudfront:CreateVpcOrigin",
  ]
  cloudfront_untagged_create_actions = [
    "cloudfront:CreateCachePolicy",
    "cloudfront:CreateOriginAccessControl",
    "cloudfront:CreateResponseHeadersPolicy",
  ]
  cognito_create_actions = [
    "cognito-idp:CreateUserPool",
  ]

  ec2_mutation_actions = [
    for action in local.deploy_foundation_actions : action
    if startswith(action, "ec2:") &&
    !contains(local.ec2_create_actions, action) &&
    !contains(local.ec2_existing_tag_actions, action)
  ]
  rds_mutation_actions = [
    for action in local.deploy_foundation_actions : action
    if startswith(action, "rds:") && !contains(local.rds_create_actions, action)
  ]
  load_balancing_mutation_actions = [
    for action in local.deploy_foundation_actions : action
    if startswith(action, "elasticloadbalancing:") && !contains(local.load_balancing_create_actions, action)
  ]
  cloudfront_tagged_mutation_actions = [
    for action in local.deploy_foundation_actions : action
    if contains([
      "cloudfront:DeleteDistribution",
      "cloudfront:DeleteFunction",
      "cloudfront:DeleteVpcOrigin",
      "cloudfront:PublishFunction",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
      "cloudfront:UpdateDistribution",
      "cloudfront:UpdateFunction",
      "cloudfront:UpdateVpcOrigin",
    ], action)
  ]
  cloudfront_scoped_mutation_actions = [
    for action in local.deploy_foundation_actions : action
    if startswith(action, "cloudfront:") &&
    !contains(local.cloudfront_tagged_create_actions, action) &&
    !contains(local.cloudfront_untagged_create_actions, action) &&
    !contains(local.cloudfront_tagged_mutation_actions, action)
  ]
  s3_foundation_actions = [
    for action in local.deploy_foundation_actions : action
    if startswith(action, "s3:")
  ]
  cognito_mutation_actions = [
    for action in local.deploy_foundation_actions : action
    if startswith(action, "cognito-idp:") && !contains(local.cognito_create_actions, action)
  ]

  request_tag_condition = {
    StringEquals = {
      "aws:RequestTag/Project"     = var.project
      "aws:RequestTag/Environment" = var.environment
      "aws:RequestTag/ManagedBy"   = "Terraform"
    }
    "ForAllValues:StringEquals" = {
      "aws:TagKeys" = ["Project", "Environment", "ManagedBy"]
    }
  }
  ec2_tag_on_create_condition = {
    StringEquals = merge(
      local.request_tag_condition.StringEquals,
      { "ec2:CreateAction" = local.ec2_tag_on_create_operations },
    )
    "ForAllValues:StringEquals" = local.request_tag_condition["ForAllValues:StringEquals"]
  }
  resource_tag_condition = {
    StringEquals = {
      "aws:ResourceTag/Project"     = var.project
      "aws:ResourceTag/Environment" = var.environment
    }
  }

  ec2_foundation_resources = [
    "arn:aws:ec2:${var.aws_region}:*:elastic-ip/*",
    "arn:aws:ec2:${var.aws_region}:*:internet-gateway/*",
    "arn:aws:ec2:${var.aws_region}:*:natgateway/*",
    "arn:aws:ec2:${var.aws_region}:*:network-interface/*",
    "arn:aws:ec2:${var.aws_region}:*:route-table/*",
    "arn:aws:ec2:${var.aws_region}:*:security-group/*",
    "arn:aws:ec2:${var.aws_region}:*:subnet/*",
    "arn:aws:ec2:${var.aws_region}:*:vpc/*",
  ]
  rds_foundation_resources = [
    "arn:aws:rds:${var.aws_region}:*:db:${var.project}-${var.environment}-*",
    "arn:aws:rds:${var.aws_region}:*:pg:${var.project}-${var.environment}-*",
    "arn:aws:rds:${var.aws_region}:*:subgrp:${var.project}-${var.environment}-*",
  ]
  load_balancing_foundation_resources = [
    "arn:aws:elasticloadbalancing:${var.aws_region}:*:loadbalancer/app/${var.project}-${var.environment}-*/*",
    "arn:aws:elasticloadbalancing:${var.aws_region}:*:targetgroup/${var.project}-${var.environment}-*/*",
    "arn:aws:elasticloadbalancing:${var.aws_region}:*:listener/app/${var.project}-${var.environment}-*/*/*",
    "arn:aws:elasticloadbalancing:${var.aws_region}:*:listener-rule/app/${var.project}-${var.environment}-*/*/*/*",
  ]
  cloudfront_tagged_resources = [
    "arn:aws:cloudfront::*:distribution/*",
    "arn:aws:cloudfront::*:function/${var.project}-${var.environment}-*",
    "arn:aws:cloudfront::*:vpcorigin/*",
  ]
  cloudfront_scoped_resources = [
    "arn:aws:cloudfront::*:cache-policy/*",
    "arn:aws:cloudfront::*:origin-access-control/*",
    "arn:aws:cloudfront::*:response-headers-policy/*",
  ]
  cloudfront_read_resources = concat(
    local.cloudfront_tagged_resources,
    local.cloudfront_scoped_resources,
  )
  s3_foundation_resources = [
    "arn:aws:s3:::${var.project}-${var.environment}-web",
    "arn:aws:s3:::${var.project}-${var.environment}-web-*",
  ]
  cognito_foundation_resources = [
    "arn:aws:cognito-idp:${var.aws_region}:*:userpool/*",
  ]
  ec2_vpc_read_resources = [
    "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:vpc/*",
  ]
  ec2_aws_managed_prefix_list_read_resources = [
    "arn:aws:ec2:${var.aws_region}:aws:prefix-list/pl-*",
  ]
  workload_ecs_resources = [
    "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cluster/${var.project}-${var.environment}",
    "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${var.project}-${var.environment}/${var.project}-${var.environment}",
    "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}-${var.environment}:*",
  ]
  workload_iam_role_resources = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-${var.environment}-task-execution",
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-${var.environment}-runtime-task",
  ]
  workload_log_group_resources = [
    "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/${var.project}/${var.environment}/*",
  ]

  foundation_read_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "FoundationEc2Read"
        Effect   = "Allow"
        Action   = local.foundation_ec2_read_actions
        Resource = "*"
      },
      {
        Sid      = "FoundationEc2VpcRead"
        Effect   = "Allow"
        Action   = local.foundation_ec2_vpc_read_actions
        Resource = local.ec2_vpc_read_resources
      },
      {
        Sid      = "FoundationEc2ManagedPrefixListRead"
        Effect   = "Allow"
        Action   = local.foundation_ec2_managed_prefix_list_read_actions
        Resource = local.ec2_aws_managed_prefix_list_read_resources
      },
      {
        Sid      = "FoundationRdsDatabaseRead"
        Effect   = "Allow"
        Action   = local.foundation_rds_database_read_actions
        Resource = [local.rds_foundation_resources[0]]
      },
      {
        Sid      = "FoundationRdsParameterGroupRead"
        Effect   = "Allow"
        Action   = local.foundation_rds_parameter_group_read_actions
        Resource = [local.rds_foundation_resources[1]]
      },
      {
        Sid      = "FoundationRdsSubnetGroupRead"
        Effect   = "Allow"
        Action   = local.foundation_rds_subnet_group_read_actions
        Resource = [local.rds_foundation_resources[2]]
      },
      {
        Sid      = "FoundationRdsTagRead"
        Effect   = "Allow"
        Action   = local.foundation_rds_tag_read_actions
        Resource = local.rds_foundation_resources
      },
      {
        Sid      = "FoundationLoadBalancingRead"
        Effect   = "Allow"
        Action   = local.foundation_load_balancing_read_actions
        Resource = "*"
      },
      {
        Sid      = "FoundationCloudFrontScopedRead"
        Effect   = "Allow"
        Action   = local.foundation_cloudfront_scoped_read_actions
        Resource = local.cloudfront_read_resources
      },
      {
        Sid      = "FoundationCloudFrontGlobalRead"
        Effect   = "Allow"
        Action   = local.foundation_cloudfront_global_read_actions
        Resource = "*"
      },
      {
        Sid      = "FoundationS3BucketRead"
        Effect   = "Allow"
        Action   = local.foundation_s3_bucket_read_actions
        Resource = local.s3_foundation_resources
      },
      {
        Sid      = "FoundationCognitoScopedRead"
        Effect   = "Allow"
        Action   = local.foundation_cognito_scoped_read_actions
        Resource = local.cognito_foundation_resources
      },
      {
        Sid      = "FoundationCognitoGlobalRead"
        Effect   = "Allow"
        Action   = local.foundation_cognito_global_read_actions
        Resource = "*"
      },
    ]
  })

  workload_read_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WorkloadEcsScopedRead"
        Effect = "Allow"
        Action = [
          "ecs:DescribeClusters",
          "ecs:DescribeServices",
          "ecs:ListTagsForResource",
        ]
        Resource = local.workload_ecs_resources
      },
      {
        Sid      = "WorkloadEcsDescribeTaskDefinition"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTaskDefinition"]
        Resource = "*"
      },
      {
        Sid      = "WorkloadEcsGlobalRead"
        Effect   = "Allow"
        Action   = ["ecs:ListTaskDefinitions"]
        Resource = "*"
      },
      {
        Sid    = "WorkloadIamRead"
        Effect = "Allow"
        Action = [
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole",
          "iam:ListRolePolicies",
          "iam:ListRoleTags",
        ]
        Resource = local.workload_iam_role_resources
      },
      {
        Sid      = "WorkloadLogsScopedRead"
        Effect   = "Allow"
        Action   = ["logs:ListTagsForResource"]
        Resource = local.workload_log_group_resources
      },
      {
        Sid      = "WorkloadLogsGlobalRead"
        Effect   = "Allow"
        Action   = ["logs:DescribeLogGroups"]
        Resource = "*"
      },
    ]
  })

  deploy_workload_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "WorkloadEcsCreateCluster"
        Effect    = "Allow"
        Action    = ["ecs:CreateCluster"]
        Resource  = "*"
        Condition = local.request_tag_condition
      },
      {
        Sid    = "WorkloadEcsMutate"
        Effect = "Allow"
        Action = [
          "ecs:DeleteCluster",
          "ecs:CreateService",
          "ecs:DeleteService",
          "ecs:UpdateService",
          "ecs:UpdateClusterSettings",
          "ecs:DeregisterTaskDefinition",
          "ecs:TagResource",
          "ecs:UntagResource",
        ]
        Resource = local.workload_ecs_resources
      },
      {
        Sid      = "WorkloadEcsRegisterTaskDefinition"
        Effect   = "Allow"
        Action   = ["ecs:RegisterTaskDefinition"]
        Resource = "*"
      },
      {
        Sid    = "WorkloadIamRoleMutate"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
          "iam:UpdateAssumeRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
        ]
        Resource = local.workload_iam_role_resources
      },
      {
        Sid      = "WorkloadIamPassRole"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = local.workload_iam_role_resources
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid      = "WorkloadIamCreateEcsServiceLinkedRole"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "iam:AWSServiceName" = "ecs.amazonaws.com"
          }
        }
      },
      {
        Sid    = "WorkloadLogsMutate"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource",
        ]
        Resource = local.workload_log_group_resources
      },
    ]
  })

  deploy_foundation_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Ec2CreateTagged"
        Effect    = "Allow"
        Action    = local.ec2_create_actions
        Resource  = "*"
        Condition = local.request_tag_condition
      },
      {
        Sid       = "Ec2TagOnCreate"
        Effect    = "Allow"
        Action    = local.ec2_tag_on_create_actions
        Resource  = local.ec2_foundation_resources
        Condition = local.ec2_tag_on_create_condition
      },
      {
        Sid       = "Ec2TagExisting"
        Effect    = "Allow"
        Action    = local.ec2_existing_tag_actions
        Resource  = local.ec2_foundation_resources
        Condition = local.resource_tag_condition
      },
      {
        Sid       = "Ec2MutateTagged"
        Effect    = "Allow"
        Action    = local.ec2_mutation_actions
        Resource  = local.ec2_foundation_resources
        Condition = local.resource_tag_condition
      },
      {
        Sid       = "RdsCreateTagged"
        Effect    = "Allow"
        Action    = local.rds_create_actions
        Resource  = local.rds_foundation_resources
        Condition = local.request_tag_condition
      },
      {
        Sid       = "RdsMutateTagged"
        Effect    = "Allow"
        Action    = local.rds_mutation_actions
        Resource  = local.rds_foundation_resources
        Condition = local.resource_tag_condition
      },
      // RDS が UUID で命名するため project 名では絞れない。secret の値の取得・更新は許可しない。
      {
        Sid      = "RdsManagedSecretCreate"
        Effect   = "Allow"
        Action   = ["secretsmanager:CreateSecret", "secretsmanager:TagResource"]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:rds!db-*"
      },
      {
        Sid      = "RdsManagedSecretKeyDescribe"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey"]
        Resource = "arn:aws:kms:${var.aws_region}:${data.aws_caller_identity.current.account_id}:key/*"
        Condition = {
          "ForAnyValue:StringEquals" = {
            "kms:ResourceAliases" = "alias/aws/secretsmanager"
          }
        }
      },
      {
        Sid       = "LoadBalancingCreateTagged"
        Effect    = "Allow"
        Action    = local.load_balancing_create_actions
        Resource  = local.load_balancing_foundation_resources
        Condition = local.request_tag_condition
      },
      {
        Sid      = "LoadBalancingMutateScoped"
        Effect   = "Allow"
        Action   = local.load_balancing_mutation_actions
        Resource = local.load_balancing_foundation_resources
      },
      {
        Sid       = "CloudFrontCreateTagged"
        Effect    = "Allow"
        Action    = local.cloudfront_tagged_create_actions
        Resource  = "*"
        Condition = local.request_tag_condition
      },
      {
        Sid      = "CloudFrontCreateUnscoped"
        Effect   = "Allow"
        Action   = local.cloudfront_untagged_create_actions
        Resource = "*"
      },
      {
        Sid       = "CloudFrontMutateTagged"
        Effect    = "Allow"
        Action    = local.cloudfront_tagged_mutation_actions
        Resource  = local.cloudfront_tagged_resources
        Condition = local.resource_tag_condition
      },
      {
        Sid      = "CloudFrontMutateScoped"
        Effect   = "Allow"
        Action   = local.cloudfront_scoped_mutation_actions
        Resource = local.cloudfront_scoped_resources
      },
      {
        Sid      = "S3BucketScoped"
        Effect   = "Allow"
        Action   = local.s3_foundation_actions
        Resource = local.s3_foundation_resources
      },
      {
        Sid      = "DenyStateBucketFoundationMutation"
        Effect   = "Deny"
        Action   = local.s3_foundation_actions
        Resource = aws_s3_bucket.state.arn
      },
      {
        Sid       = "CognitoCreateTagged"
        Effect    = "Allow"
        Action    = local.cognito_create_actions
        Resource  = "*"
        Condition = local.request_tag_condition
      },
      {
        Sid       = "CognitoMutateTagged"
        Effect    = "Allow"
        Action    = local.cognito_mutation_actions
        Resource  = local.cognito_foundation_resources
        Condition = local.resource_tag_condition
      },
    ]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider && local.create_github_roles ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "plan" {
  count = var.create_github_plan_role ? 1 : 0

  name                 = "${var.project}-${var.environment}-github-plan"
  assume_role_policy   = local.plan_trust_policy
  max_session_duration = 3600

  lifecycle {
    precondition {
      condition     = local.github_oidc_provider_mode_is_valid
      error_message = "Create the GitHub OIDC provider or supply its ARN, but not both."
    }
  }
}

resource "aws_iam_role" "deploy" {
  count = var.create_github_deploy_role ? 1 : 0

  name                 = "${var.project}-${var.environment}-github-deploy"
  assume_role_policy   = local.deploy_trust_policy
  max_session_duration = 3600

  // plan role が無効でも、provider の指定誤りで apply が進まないようにする。
  lifecycle {
    precondition {
      condition     = local.github_oidc_provider_mode_is_valid
      error_message = "Create the GitHub OIDC provider or supply its ARN, but not both."
    }
  }
}

resource "aws_iam_policy" "foundation_read" {
  count = local.create_github_roles ? 1 : 0

  name   = "${var.project}-${var.environment}-foundation-read"
  policy = local.foundation_read_policy
}

resource "aws_iam_role_policy_attachment" "plan_foundation_read" {
  count = var.create_github_plan_role ? 1 : 0

  role       = aws_iam_role.plan[0].name
  policy_arn = aws_iam_policy.foundation_read[0].arn
}

resource "aws_iam_role_policy_attachment" "deploy_foundation_read" {
  count = var.create_github_deploy_role ? 1 : 0

  role       = aws_iam_role.deploy[0].name
  policy_arn = aws_iam_policy.foundation_read[0].arn
}

resource "aws_iam_policy" "workload_read" {
  count = local.create_github_roles ? 1 : 0

  name   = "${var.project}-${var.environment}-workload-read"
  policy = local.workload_read_policy
}

resource "aws_iam_role_policy_attachment" "plan_workload_read" {
  count = var.create_github_plan_role ? 1 : 0

  role       = aws_iam_role.plan[0].name
  policy_arn = aws_iam_policy.workload_read[0].arn
}

resource "aws_iam_role_policy_attachment" "deploy_workload_read" {
  count = var.create_github_deploy_role ? 1 : 0

  role       = aws_iam_role.deploy[0].name
  policy_arn = aws_iam_policy.workload_read[0].arn
}

resource "aws_iam_role_policy" "plan_state" {
  count = var.create_github_plan_role ? 1 : 0

  name   = "${var.project}-${var.environment}-terraform-state"
  role   = aws_iam_role.plan[0].id
  policy = local.plan_state_access_policy
}

resource "aws_iam_role_policy" "deploy_state" {
  count = var.create_github_deploy_role ? 1 : 0

  name   = "${var.project}-${var.environment}-terraform-state"
  role   = aws_iam_role.deploy[0].id
  policy = local.deploy_state_access_policy
}

locals {
  // Role の inline 合計上限と managed policy の個別上限に収まるよう、権限を変更せず分割する。
  deploy_foundation_network_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
      if startswith(statement.Sid, "Ec2") || startswith(statement.Sid, "LoadBalancing")
    ]
  })
  deploy_foundation_services_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
      if statement.Effect == "Allow" && !startswith(statement.Sid, "Ec2") && !startswith(statement.Sid, "LoadBalancing")
    ]
  })
  deploy_foundation_deny_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
      if statement.Effect == "Deny"
    ]
  })
}

resource "aws_iam_policy" "deploy_foundation_network" {
  count = var.create_github_deploy_role ? 1 : 0

  name   = "${var.project}-${var.environment}-foundation-network"
  policy = local.deploy_foundation_network_policy
}

resource "aws_iam_policy" "deploy_foundation_services" {
  count = var.create_github_deploy_role ? 1 : 0

  name   = "${var.project}-${var.environment}-foundation-services"
  policy = local.deploy_foundation_services_policy
}

resource "aws_iam_role_policy_attachment" "deploy_foundation_network" {
  count = var.create_github_deploy_role ? 1 : 0

  role       = aws_iam_role.deploy[0].name
  policy_arn = aws_iam_policy.deploy_foundation_network[0].arn
}

resource "aws_iam_role_policy_attachment" "deploy_foundation_services" {
  count = var.create_github_deploy_role ? 1 : 0

  role       = aws_iam_role.deploy[0].name
  policy_arn = aws_iam_policy.deploy_foundation_services[0].arn
}

resource "aws_iam_role_policy" "deploy_foundation" {
  count = var.create_github_deploy_role ? 1 : 0

  name   = "${var.project}-${var.environment}-foundation"
  role   = aws_iam_role.deploy[0].id
  policy = local.deploy_foundation_deny_policy

  // 既存 inline を縮小する前に代替権限を付与し、移行時の権限消失を防ぐ。
  depends_on = [
    aws_iam_role_policy_attachment.deploy_foundation_network[0],
    aws_iam_role_policy_attachment.deploy_foundation_services[0],
  ]
}

resource "aws_iam_role_policy" "deploy_workload" {
  count = var.create_github_deploy_role ? 1 : 0

  name   = "${var.project}-${var.environment}-workload"
  role   = aws_iam_role.deploy[0].id
  policy = local.deploy_workload_policy
}

// count を付ける前の単一インスタンスからの移動記録。
moved {
  from = aws_iam_role.plan
  to   = aws_iam_role.plan[0]
}

moved {
  from = aws_iam_role.deploy
  to   = aws_iam_role.deploy[0]
}

moved {
  from = aws_iam_policy.foundation_read
  to   = aws_iam_policy.foundation_read[0]
}

moved {
  from = aws_iam_policy.workload_read
  to   = aws_iam_policy.workload_read[0]
}

moved {
  from = aws_iam_policy.deploy_foundation_network
  to   = aws_iam_policy.deploy_foundation_network[0]
}

moved {
  from = aws_iam_policy.deploy_foundation_services
  to   = aws_iam_policy.deploy_foundation_services[0]
}

moved {
  from = aws_iam_role_policy_attachment.plan_foundation_read
  to   = aws_iam_role_policy_attachment.plan_foundation_read[0]
}

moved {
  from = aws_iam_role_policy_attachment.plan_workload_read
  to   = aws_iam_role_policy_attachment.plan_workload_read[0]
}

moved {
  from = aws_iam_role_policy_attachment.deploy_foundation_read
  to   = aws_iam_role_policy_attachment.deploy_foundation_read[0]
}

moved {
  from = aws_iam_role_policy_attachment.deploy_workload_read
  to   = aws_iam_role_policy_attachment.deploy_workload_read[0]
}

moved {
  from = aws_iam_role_policy_attachment.deploy_foundation_network
  to   = aws_iam_role_policy_attachment.deploy_foundation_network[0]
}

moved {
  from = aws_iam_role_policy_attachment.deploy_foundation_services
  to   = aws_iam_role_policy_attachment.deploy_foundation_services[0]
}

moved {
  from = aws_iam_role_policy.plan_state
  to   = aws_iam_role_policy.plan_state[0]
}

moved {
  from = aws_iam_role_policy.deploy_state
  to   = aws_iam_role_policy.deploy_state[0]
}

moved {
  from = aws_iam_role_policy.deploy_foundation
  to   = aws_iam_role_policy.deploy_foundation[0]
}

moved {
  from = aws_iam_role_policy.deploy_workload
  to   = aws_iam_role_policy.deploy_workload[0]
}

resource "aws_s3_bucket" "state" {
  bucket        = var.state_bucket_name
  force_destroy = var.state_bucket_force_destroy
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = local.state_bucket_policy
}

resource "aws_ecr_repository" "api" {
  name                 = "${var.project}-${var.environment}-api"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.ecr_force_delete

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy     = local.ecr_lifecycle_policy
}
