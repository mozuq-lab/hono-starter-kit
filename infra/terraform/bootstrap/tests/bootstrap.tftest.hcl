mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
      id         = "123456789012"
      user_id    = "123456789012"
    }
    override_during = plan
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::hono-starter-kit-dev-state-123456789012"
      id  = "hono-starter-kit-dev-state-123456789012"
    }
    override_during = plan
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:ap-northeast-1:123456789012:repository/hono-starter-kit-dev-api"
      repository_url = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api"
    }
    override_during = plan
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
    override_during = plan
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-github-role"
    }
    override_during = plan
  }

  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::123456789012:policy/hono-starter-kit-dev-foundation-read"
    }
    override_during = plan
  }
}

// tfvars や -var に依存させないため、全変数をここで固定する。既定値を持つ変数は既定値と同じ値にする。
// 値と variables.tf の default の一致は scripts/terraform-test-isolation.test.ts が守る。
variables {
  aws_account_id              = "123456789012"
  project                     = "hono-starter-kit"
  environment                 = "dev"
  aws_region                  = "ap-northeast-1"
  state_bucket_name           = "hono-starter-kit-dev-state-123456789012"
  github_owner                = "example-owner"
  github_repository           = "hono-starter-kit"
  github_default_branch       = "main"
  create_github_oidc_provider = true
  create_github_plan_role     = false
  create_github_deploy_role   = false
  github_oidc_provider_arn    = null
  state_bucket_force_destroy  = false
  ecr_force_delete            = false
}

run "state_and_registry_are_private_and_recoverable" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == var.state_bucket_name
    error_message = "The configured state bucket name must be used exactly."
  }

  assert {
    condition     = aws_s3_bucket.state.force_destroy == false
    error_message = "State must not be force-destroyed."
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "State object ownership must be enforced by the bucket owner."
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State versioning must be enabled."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.state.block_public_acls &&
      aws_s3_bucket_public_access_block.state.block_public_policy &&
      aws_s3_bucket_public_access_block.state.ignore_public_acls &&
      aws_s3_bucket_public_access_block.state.restrict_public_buckets
    )
    error_message = "Every S3 public-access block must be enabled."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "State must use S3-managed AES256 encryption."
  }

  assert {
    condition = (
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Effect == "Deny" &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Principal == "*" &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Action == "s3:*" &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false" &&
      length(jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Resource) == 2 &&
      contains(jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Resource, aws_s3_bucket.state.arn) &&
      contains(jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Resource, "${aws_s3_bucket.state.arn}/*")
    )
    error_message = "The state bucket policy must deny insecure transport for the bucket and its objects."
  }

  assert {
    condition     = aws_ecr_repository.api.name == "hono-starter-kit-dev-api"
    error_message = "The API repository name must follow the project/environment contract."
  }

  assert {
    condition     = aws_ecr_repository.api.image_tag_mutability == "IMMUTABLE"
    error_message = "Release image tags must be immutable."
  }

  assert {
    condition     = aws_ecr_repository.api.force_delete == false
    error_message = "The API repository must not be force-deleted."
  }

  assert {
    condition     = aws_ecr_repository.api.image_scanning_configuration[0].scan_on_push
    error_message = "API images must be scanned on push."
  }

  assert {
    condition     = aws_ecr_repository.api.encryption_configuration[0].encryption_type == "AES256"
    error_message = "The API repository must use AES256 encryption."
  }

  assert {
    condition = (
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].rulePriority == 1 &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].selection.tagStatus == "untagged" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].selection.countType == "sinceImagePushed" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].selection.countUnit == "days" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].selection.countNumber == 7 &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[0].action.type == "expire"
    )
    error_message = "Untagged images must expire after seven days."
  }

  assert {
    condition = (
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].rulePriority == 2 &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].selection.tagStatus == "tagged" &&
      length(jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].selection.tagPrefixList) == 1 &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].selection.tagPrefixList[0] == "release-" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].selection.countType == "imageCountMoreThan" &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].selection.countNumber == 20 &&
      jsondecode(aws_ecr_lifecycle_policy.api.policy).rules[1].action.type == "expire"
    )
    error_message = "Only the latest 20 release-tagged images may be retained."
  }

  assert {
    condition = (
      output.state_bucket_name == var.state_bucket_name &&
      output.state_bucket_region == var.aws_region &&
      output.ecr_repository_name == "hono-starter-kit-dev-api" &&
      output.ecr_repository_url == "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api" &&
      output.ecr_repository_arn == "arn:aws:ecr:ap-northeast-1:123456789012:repository/hono-starter-kit-dev-api"
    )
    error_message = "Bootstrap outputs must expose the exact state and repository interface."
  }
}

run "github_roles_are_not_created_when_disabled" {
  command = plan

  assert {
    condition = (
      length(aws_iam_role.plan) == 0 &&
      length(aws_iam_role.deploy) == 0 &&
      length(aws_iam_openid_connect_provider.github) == 0 &&
      length(aws_iam_policy.foundation_read) == 0 &&
      length(aws_iam_policy.workload_read) == 0 &&
      length(aws_iam_policy.deploy_foundation_network) == 0 &&
      length(aws_iam_policy.deploy_foundation_services) == 0 &&
      output.github_plan_role_arn == null &&
      output.github_deploy_role_arn == null
    )
    error_message = "role を無効にしたとき、role・共有 policy・OIDC provider を作ってはならない。"
  }
}

run "created_provider_roles_are_repository_scoped" {
  command = plan

  variables {
    create_github_plan_role   = true
    create_github_deploy_role = true
  }

  assert {
    condition = (
      length(aws_iam_role_policy.deploy_foundation[0].policy) +
      length(aws_iam_role_policy.deploy_state[0].policy) +
      length(aws_iam_role_policy.deploy_workload[0].policy) <= 10240 &&
      length(aws_iam_role_policy.plan_state[0].policy) <= 10240
    )
    error_message = "IAM role の inline policy は合計 10,240 文字以内でなければ AWS に作成できない。"
  }

  assert {
    condition = (
      alltrue([
        for policy in [aws_iam_policy.foundation_read[0].policy, aws_iam_policy.workload_read[0].policy, aws_iam_policy.deploy_foundation_network[0].policy, aws_iam_policy.deploy_foundation_services[0].policy] : length(policy) <= 6144
      ]) &&
      length([aws_iam_role_policy_attachment.deploy_foundation_read[0], aws_iam_role_policy_attachment.deploy_workload_read[0], aws_iam_role_policy_attachment.deploy_foundation_network[0], aws_iam_role_policy_attachment.deploy_foundation_services[0]]) <= 10 &&
      length([aws_iam_role_policy_attachment.plan_foundation_read[0], aws_iam_role_policy_attachment.plan_workload_read[0]]) <= 10
    )
    error_message = "Managed policy は個別に 6,144 文字以内、role ごとの attachment は既定上限の 10 個以内に収める。"
  }

  assert {
    condition = (
      aws_iam_role_policy_attachment.deploy_foundation_network[0].role == aws_iam_role.deploy[0].name &&
      aws_iam_role_policy_attachment.deploy_foundation_network[0].policy_arn == aws_iam_policy.deploy_foundation_network[0].arn &&
      aws_iam_role_policy_attachment.deploy_foundation_services[0].role == aws_iam_role.deploy[0].name &&
      aws_iam_role_policy_attachment.deploy_foundation_services[0].policy_arn == aws_iam_policy.deploy_foundation_services[0].arn &&
      sort(concat(
        [for statement in jsondecode(aws_iam_policy.deploy_foundation_network[0].policy).Statement : jsonencode(statement)],
        [for statement in jsondecode(aws_iam_policy.deploy_foundation_services[0].policy).Statement : jsonencode(statement)],
        [for statement in jsondecode(aws_iam_role_policy.deploy_foundation[0].policy).Statement : jsonencode(statement)],
      )) == sort([for statement in jsondecode(local.deploy_foundation_policy).Statement : jsonencode(statement)]) &&
      alltrue([for statement in jsondecode(aws_iam_role_policy.deploy_foundation[0].policy).Statement : statement.Effect == "Deny"])
    )
    error_message = "分割した managed policy と既存 inline の deny は、検証済みの全 foundation 権限を欠落・重複なく deploy role に付与する。"
  }

  override_resource {
    target          = aws_iam_policy.workload_read[0]
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:policy/hono-starter-kit-dev-workload-read"
    }
  }

  assert {
    condition = (
      length(aws_iam_openid_connect_provider.github) == 1 &&
      one(aws_iam_openid_connect_provider.github).url == "https://token.actions.githubusercontent.com" &&
      length(one(aws_iam_openid_connect_provider.github).client_id_list) == 1 &&
      one(one(aws_iam_openid_connect_provider.github).client_id_list) == "sts.amazonaws.com"
    )
    error_message = "Create mode must own the GitHub Actions OIDC provider with the STS audience."
  }

  assert {
    condition = one([
      for statement in jsondecode(aws_iam_role.plan[0].assume_role_policy).Statement :
      statement.Condition.StringEquals["token.actions.githubusercontent.com:sub"]
      if statement.Effect == "Allow"
    ]) == "repo:example-owner/hono-starter-kit:ref:refs/heads/main"
    error_message = "Plan trust must be restricted to the default branch."
  }

  assert {
    condition = one([
      for statement in jsondecode(aws_iam_role.deploy[0].assume_role_policy).Statement :
      statement.Condition.StringEquals["token.actions.githubusercontent.com:sub"]
      if statement.Effect == "Allow"
    ]) == "repo:example-owner/hono-starter-kit:environment:dev"
    error_message = "Deploy trust must be restricted to the dev environment."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(aws_iam_role.plan[0].assume_role_policy).Statement :
        statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"]
        if statement.Effect == "Allow"
      ]) == "sts.amazonaws.com" &&
      one([
        for statement in jsondecode(aws_iam_role.deploy[0].assume_role_policy).Statement :
        statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"]
        if statement.Effect == "Allow"
      ]) == "sts.amazonaws.com"
    )
    error_message = "Both GitHub trusts must require the AWS STS audience."
  }

  assert {
    condition = (
      aws_iam_role.plan[0].name == "hono-starter-kit-dev-github-plan" &&
      aws_iam_role.plan[0].max_session_duration == 3600 &&
      aws_iam_role.deploy[0].name == "hono-starter-kit-dev-github-deploy" &&
      aws_iam_role.deploy[0].max_session_duration == 3600
    )
    error_message = "GitHub roles must remain distinct and session-bounded."
  }

  assert {
    condition = (
      aws_iam_role_policy_attachment.plan_foundation_read[0].role == aws_iam_role.plan[0].name &&
      aws_iam_role_policy_attachment.deploy_foundation_read[0].role == aws_iam_role.deploy[0].name &&
      aws_iam_role_policy_attachment.plan_foundation_read[0].policy_arn == aws_iam_policy.foundation_read[0].arn &&
      aws_iam_role_policy_attachment.deploy_foundation_read[0].policy_arn == aws_iam_policy.foundation_read[0].arn &&
      aws_iam_policy.foundation_read[0].name == "hono-starter-kit-dev-foundation-read" &&
      aws_iam_policy.foundation_read[0].arn == "arn:aws:iam::123456789012:policy/hono-starter-kit-dev-foundation-read" &&
      aws_iam_role_policy_attachment.plan_workload_read[0].role == aws_iam_role.plan[0].name &&
      aws_iam_role_policy_attachment.deploy_workload_read[0].role == aws_iam_role.deploy[0].name &&
      aws_iam_role_policy_attachment.plan_workload_read[0].policy_arn == aws_iam_policy.workload_read[0].arn &&
      aws_iam_role_policy_attachment.deploy_workload_read[0].policy_arn == aws_iam_policy.workload_read[0].arn &&
      aws_iam_policy.workload_read[0].name == "hono-starter-kit-dev-workload-read" &&
      aws_iam_policy.workload_read[0].arn == "arn:aws:iam::123456789012:policy/hono-starter-kit-dev-workload-read" &&
      aws_iam_role_policy.deploy_workload[0].role == aws_iam_role.deploy[0].id &&
      aws_iam_role_policy.deploy_workload[0].name == "hono-starter-kit-dev-workload"
    )
    error_message = "Both roles must attach the exact repository-owned read policies, while only deploy receives workload mutation."
  }

  assert {
    condition = alltrue(flatten([
      for policy in [
        jsondecode(aws_iam_role_policy.plan_state[0].policy),
        jsondecode(aws_iam_role_policy.deploy_state[0].policy),
        jsondecode(aws_iam_policy.foundation_read[0].policy),
        jsondecode(local.deploy_foundation_policy),
        jsondecode(aws_iam_policy.workload_read[0].policy),
        jsondecode(aws_iam_role_policy.deploy_workload[0].policy),
        ] : [
        for statement in policy.Statement : [
          for action in statement.Action : action != "*" && !strcontains(action, "*")
        ]
      ]
    ]))
    error_message = "Repository-owned IAM policies must contain only explicit action names."
  }

  assert {
    condition = (
      jsondecode(aws_iam_policy.workload_read[0].policy).Version == "2012-10-17" &&
      [
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement.Sid
        ] == [
        "WorkloadEcsScopedRead",
        "WorkloadEcsDescribeTaskDefinition",
        "WorkloadEcsGlobalRead",
        "WorkloadIamRead",
        "WorkloadLogsScopedRead",
        "WorkloadLogsGlobalRead",
      ] &&
      alltrue([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement.Effect == "Allow"
      ]) &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsScopedRead"
        ]).Action == [
        "ecs:DescribeClusters",
        "ecs:DescribeServices",
        "ecs:ListTagsForResource",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsScopedRead"
        ]).Resource == [
        "arn:aws:ecs:ap-northeast-1:123456789012:cluster/hono-starter-kit-dev",
        "arn:aws:ecs:ap-northeast-1:123456789012:service/hono-starter-kit-dev/hono-starter-kit-dev",
        "arn:aws:ecs:ap-northeast-1:123456789012:task-definition/hono-starter-kit-dev:*",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsDescribeTaskDefinition"
      ]).Action == ["ecs:DescribeTaskDefinition"] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsDescribeTaskDefinition"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsGlobalRead"
      ]).Action == ["ecs:ListTaskDefinitions"] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsGlobalRead"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamRead"
        ]).Action == [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole",
        "iam:ListRolePolicies",
        "iam:ListRoleTags",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamRead"
        ]).Resource == [
        "arn:aws:iam::123456789012:role/hono-starter-kit-dev-task-execution",
        "arn:aws:iam::123456789012:role/hono-starter-kit-dev-runtime-task",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadLogsScopedRead"
      ]).Action == ["logs:ListTagsForResource"] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadLogsScopedRead"
      ]).Resource == ["arn:aws:logs:ap-northeast-1:123456789012:log-group:/hono-starter-kit/dev/*"] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadLogsGlobalRead"
      ]).Action == ["logs:DescribeLogGroups"] &&
      one([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement
        if statement.Sid == "WorkloadLogsGlobalRead"
      ]).Resource == "*" &&
      alltrue([
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : !contains(keys(statement), "Condition")
      ])
    )
    error_message = "The shared workload read policy must have the exact ECS, IAM, and Logs action/resource inventory."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Version == "2012-10-17" &&
      [
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement.Sid
        ] == [
        "WorkloadEcsCreateCluster",
        "WorkloadEcsMutate",
        "WorkloadEcsRegisterTaskDefinition",
        "WorkloadIamRoleMutate",
        "WorkloadIamPassRole",
        "WorkloadIamCreateEcsServiceLinkedRole",
        "WorkloadLogsMutate",
      ] &&
      alltrue([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement.Effect == "Allow"
      ]) &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsCreateCluster"
      ]).Action == ["ecs:CreateCluster"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsCreateCluster"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsCreateCluster"
        ]).Condition == {
        StringEquals = {
          "aws:RequestTag/Project"     = "hono-starter-kit"
          "aws:RequestTag/Environment" = "dev"
          "aws:RequestTag/ManagedBy"   = "Terraform"
        }
        "ForAllValues:StringEquals" = {
          "aws:TagKeys" = ["Project", "Environment", "ManagedBy"]
        }
      } &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsMutate"
        ]).Action == [
        "ecs:DeleteCluster",
        "ecs:CreateService",
        "ecs:DeleteService",
        "ecs:UpdateService",
        "ecs:UpdateClusterSettings",
        "ecs:DeregisterTaskDefinition",
        "ecs:TagResource",
        "ecs:UntagResource",
      ] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsMutate"
        ]).Resource == [
        "arn:aws:ecs:ap-northeast-1:123456789012:cluster/hono-starter-kit-dev",
        "arn:aws:ecs:ap-northeast-1:123456789012:service/hono-starter-kit-dev/hono-starter-kit-dev",
        "arn:aws:ecs:ap-northeast-1:123456789012:task-definition/hono-starter-kit-dev:*",
      ] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsRegisterTaskDefinition"
      ]).Action == ["ecs:RegisterTaskDefinition"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadEcsRegisterTaskDefinition"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamRoleMutate"
        ]).Action == [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:UpdateRole",
        "iam:UpdateRoleDescription",
        "iam:UpdateAssumeRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
      ] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamRoleMutate"
        ]).Resource == [
        "arn:aws:iam::123456789012:role/hono-starter-kit-dev-task-execution",
        "arn:aws:iam::123456789012:role/hono-starter-kit-dev-runtime-task",
      ] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamPassRole"
      ]).Action == ["iam:PassRole"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamPassRole"
        ]).Resource == [
        "arn:aws:iam::123456789012:role/hono-starter-kit-dev-task-execution",
        "arn:aws:iam::123456789012:role/hono-starter-kit-dev-runtime-task",
      ] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamPassRole"
        ]).Condition == {
        StringEquals = {
          "iam:PassedToService" = "ecs-tasks.amazonaws.com"
        }
      } &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamCreateEcsServiceLinkedRole"
      ]).Action == ["iam:CreateServiceLinkedRole"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamCreateEcsServiceLinkedRole"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadIamCreateEcsServiceLinkedRole"
        ]).Condition == {
        StringEquals = {
          "iam:AWSServiceName" = "ecs.amazonaws.com"
        }
      } &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadLogsMutate"
        ]).Action == [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
      ] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement
        if statement.Sid == "WorkloadLogsMutate"
      ]).Resource == ["arn:aws:logs:ap-northeast-1:123456789012:log-group:/hono-starter-kit/dev/*"] &&
      alltrue([
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : (
          contains([
            "WorkloadEcsCreateCluster",
            "WorkloadIamPassRole",
            "WorkloadIamCreateEcsServiceLinkedRole",
          ], statement.Sid) == contains(keys(statement), "Condition")
        )
      ])
    )
    error_message = "Deploy workload mutation must have the exact scoped ECS, IAM, and Logs action/resource/condition inventory."
  }

  assert {
    condition = (
      [
        for statement in jsondecode(aws_iam_policy.workload_read[0].policy).Statement : statement.Sid
        if statement.Resource == "*"
        ] == [
        "WorkloadEcsDescribeTaskDefinition",
        "WorkloadEcsGlobalRead",
        "WorkloadLogsGlobalRead",
      ] &&
      [
        for statement in jsondecode(aws_iam_role_policy.deploy_workload[0].policy).Statement : statement.Sid
        if statement.Resource == "*"
        ] == [
        "WorkloadEcsCreateCluster",
        "WorkloadEcsRegisterTaskDefinition",
        "WorkloadIamCreateEcsServiceLinkedRole",
      ]
    )
    error_message = "Workload Resource = \"*\" must remain isolated to reviewed global, request-tagged creation, registration, and service-linked-role statements."
  }

  assert {
    condition = (
      jsondecode(aws_iam_policy.foundation_read[0].policy).Version == "2012-10-17" &&
      [
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement.Sid
        ] == [
        "FoundationEc2Read",
        "FoundationEc2VpcRead",
        "FoundationEc2ManagedPrefixListRead",
        "FoundationRdsDatabaseRead",
        "FoundationRdsParameterGroupRead",
        "FoundationRdsSubnetGroupRead",
        "FoundationRdsTagRead",
        "FoundationLoadBalancingRead",
        "FoundationCloudFrontScopedRead",
        "FoundationCloudFrontGlobalRead",
        "FoundationS3BucketRead",
        "FoundationCognitoScopedRead",
        "FoundationCognitoGlobalRead",
      ] &&
      alltrue([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement.Effect == "Allow"
      ])
    )
    error_message = "The shared foundation read policy must contain exactly the reviewed service/resource boundaries."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.plan_state[0].policy).Version == "2012-10-17" &&
      length(jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement) == 3 &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationEc2Read"
        ]).Action == [
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
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationEc2Read"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationRdsDatabaseRead"
      ]).Action == ["rds:DescribeDBInstances"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationRdsDatabaseRead"
      ]).Resource == ["arn:aws:rds:ap-northeast-1:*:db:hono-starter-kit-dev-*"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationRdsParameterGroupRead"
        ]).Action == [
        "rds:DescribeDBParameterGroups",
        "rds:DescribeDBParameters",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationRdsParameterGroupRead"
      ]).Resource == ["arn:aws:rds:ap-northeast-1:*:pg:hono-starter-kit-dev-*"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationRdsSubnetGroupRead"
      ]).Action == ["rds:DescribeDBSubnetGroups"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationRdsSubnetGroupRead"
      ]).Resource == ["arn:aws:rds:ap-northeast-1:*:subgrp:hono-starter-kit-dev-*"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationRdsTagRead"
      ]).Action == ["rds:ListTagsForResource"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationRdsTagRead"
        ]).Resource == [
        "arn:aws:rds:ap-northeast-1:*:db:hono-starter-kit-dev-*",
        "arn:aws:rds:ap-northeast-1:*:pg:hono-starter-kit-dev-*",
        "arn:aws:rds:ap-northeast-1:*:subgrp:hono-starter-kit-dev-*",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationLoadBalancingRead"
        ]).Action == [
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeLoadBalancerAttributes",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeRules",
        "elasticloadbalancing:DescribeTags",
        "elasticloadbalancing:DescribeTargetGroupAttributes",
        "elasticloadbalancing:DescribeTargetGroups",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationLoadBalancingRead"
      ]).Resource == "*"
    )
    error_message = "EC2 and load-balancing reads must be explicit; RDS reads must also use the supported foundation ARN boundaries."
  }

  assert {
    condition = try(
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationEc2VpcRead"
      ]).Action == ["ec2:DescribeVpcAttribute"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationEc2VpcRead"
      ]).Resource == ["arn:aws:ec2:ap-northeast-1:123456789012:vpc/*"],
      false,
    )
    error_message = "ec2:DescribeVpcAttribute must use the current-account/current-region VPC ARN family instead of Resource = \"*\" or a cross-account wildcard."
  }

  assert {
    condition = try(
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationEc2ManagedPrefixListRead"
      ]).Action == ["ec2:GetManagedPrefixListEntries"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationEc2ManagedPrefixListRead"
      ]).Resource == ["arn:aws:ec2:ap-northeast-1:aws:prefix-list/pl-*"],
      false,
    )
    error_message = "ec2:GetManagedPrefixListEntries must be scoped to the current-region AWS-managed prefix-list ARN family."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationCloudFrontScopedRead"
        ]).Action == [
        "cloudfront:DescribeFunction",
        "cloudfront:GetCachePolicy",
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig",
        "cloudfront:GetFunction",
        "cloudfront:GetOriginAccessControl",
        "cloudfront:GetResponseHeadersPolicy",
        "cloudfront:GetVpcOrigin",
        "cloudfront:ListTagsForResource",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationCloudFrontScopedRead"
        ]).Resource == [
        "arn:aws:cloudfront::*:distribution/*",
        "arn:aws:cloudfront::*:function/hono-starter-kit-dev-*",
        "arn:aws:cloudfront::*:vpcorigin/*",
        "arn:aws:cloudfront::*:cache-policy/*",
        "arn:aws:cloudfront::*:origin-access-control/*",
        "arn:aws:cloudfront::*:response-headers-policy/*",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationCloudFrontGlobalRead"
        ]).Action == [
        "cloudfront:ListCachePolicies",
        "cloudfront:ListDistributions",
        "cloudfront:ListFunctions",
        "cloudfront:ListOriginAccessControls",
        "cloudfront:ListResponseHeadersPolicies",
        "cloudfront:ListVpcOrigins",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationCloudFrontGlobalRead"
      ]).Resource == "*"
    )
    error_message = "CloudFront refresh reads must separate resource-scoped Get operations from account-level lists."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationS3BucketRead"
        ]).Action == [
        "s3:GetBucketLocation",
        "s3:GetBucketOwnershipControls",
        "s3:GetBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketTagging",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:ListBucket",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationS3BucketRead"
        ]).Resource == [
        "arn:aws:s3:::hono-starter-kit-dev-web",
        "arn:aws:s3:::hono-starter-kit-dev-web-*",
      ] &&
      alltrue(flatten([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : [
          for action in statement.Action : (
            action != "s3:GetObject" &&
            action != "s3:Get*" &&
            action != "s3:List*"
          )
        ]
      ]))
    )
    error_message = "Foundation S3 refresh permissions must remain bucket-scoped and must never grant object reads or wildcard reads."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationCognitoScopedRead"
        ]).Action == [
        "cognito-idp:DescribeManagedLoginBranding",
        "cognito-idp:DescribeManagedLoginBrandingByClient",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:GetUserPoolMfaConfig",
        "cognito-idp:ListTagsForResource",
        "cognito-idp:ListUserPoolClients",
      ] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationCognitoScopedRead"
      ]).Resource == ["arn:aws:cognito-idp:ap-northeast-1:*:userpool/*"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationCognitoGlobalRead"
      ]).Action == ["cognito-idp:DescribeUserPoolDomain"] &&
      one([
        for statement in jsondecode(aws_iam_policy.foundation_read[0].policy).Statement : statement
        if statement.Sid == "FoundationCognitoGlobalRead"
      ]).Resource == "*"
    )
    error_message = "Cognito refresh reads must scope user-pool operations while keeping only the unsupported domain lookup global."
  }

  assert {
    condition = alltrue([
      for action in flatten([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement.Action
        ]) : (
        !startswith(action, "ecs:") &&
        !startswith(action, "iam:") &&
        !startswith(action, "logs:") &&
        !startswith(action, "xray:") &&
        (!startswith(action, "secretsmanager:") || contains(["secretsmanager:CreateSecret", "secretsmanager:TagResource"], action)) &&
        !startswith(action, "ecr:")
      )
    ])
    error_message = "Deploy foundation は RDS 管理 secret の作成とタグ以外の secret 操作、workload、telemetry、ECR 配信を許可してはならない。"
  }

  assert {
    condition = alltrue([
      for action in ["cognito-idp:CreateManagedLoginBranding", "cognito-idp:UpdateManagedLoginBranding", "cognito-idp:DeleteManagedLoginBranding"] :
      contains(one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "CognitoMutateTagged"
      ]).Action, action)
    ])
    error_message = "Managed Login branding の作成・更新・削除は所有 user pool の条件付き権限に含める。"
  }

  assert {
    condition = try(
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "RdsManagedSecretCreate"
      ]).Action == ["secretsmanager:CreateSecret", "secretsmanager:TagResource"] &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "RdsManagedSecretCreate"
      ]).Resource == "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:rds!db-*" &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "RdsManagedSecretKeyDescribe"
      ]).Action == ["kms:DescribeKey"] &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "RdsManagedSecretKeyDescribe"
      ]).Resource == "arn:aws:kms:ap-northeast-1:123456789012:key/*" &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "RdsManagedSecretKeyDescribe"
      ]).Condition["ForAnyValue:StringEquals"]["kms:ResourceAliases"] == "alias/aws/secretsmanager",
      false
    )
    error_message = "RDS 管理 secret の作成権限は同一 account/region の RDS secret と既定 Secrets Manager KMS key に限定する。"
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement : statement
        if statement.Sid == "StateBucket"
      ]).Action == ["s3:GetBucketLocation", "s3:ListBucket"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement : statement
        if statement.Sid == "StateBucket"
      ]).Resource == aws_s3_bucket.state.arn &&
      !contains(keys(one([
        for statement in jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement : statement
        if statement.Sid == "StateBucket"
      ])), "Condition") &&
      one([
        for statement in jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement : statement
        if statement.Sid == "StateObjectRead"
      ]).Action == ["s3:GetObject"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement : statement
        if statement.Sid == "StateObjectRead"
      ]).Resource == "${aws_s3_bucket.state.arn}/hono-starter-kit/dev/terraform.tfstate" &&
      !contains(one([
        for statement in jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement : statement
        if statement.Sid == "StateObjectRead"
      ]).Action, "s3:DeleteObject") &&
      one([
        for statement in jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement : statement
        if statement.Sid == "StateLock"
      ]).Action == ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.plan_state[0].policy).Statement : statement
        if statement.Sid == "StateLock"
      ]).Resource == "${aws_s3_bucket.state.arn}/hono-starter-kit/dev/terraform.tfstate.tflock" &&
      jsondecode(aws_iam_role_policy.deploy_state[0].policy).Version == "2012-10-17" &&
      length(jsondecode(aws_iam_role_policy.deploy_state[0].policy).Statement) == 3 &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_state[0].policy).Statement : statement
        if statement.Sid == "StateBucket"
      ]).Action == ["s3:GetBucketLocation", "s3:ListBucket"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_state[0].policy).Statement : statement
        if statement.Sid == "StateBucket"
      ]).Resource == aws_s3_bucket.state.arn &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_state[0].policy).Statement : statement
        if statement.Sid == "StateObject"
      ]).Action == ["s3:GetObject", "s3:PutObject"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_state[0].policy).Statement : statement
        if statement.Sid == "StateObject"
      ]).Resource == "${aws_s3_bucket.state.arn}/hono-starter-kit/dev/terraform.tfstate" &&
      !contains(one([
        for statement in jsondecode(aws_iam_role_policy.deploy_state[0].policy).Statement : statement
        if statement.Sid == "StateObject"
      ]).Action, "s3:DeleteObject") &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_state[0].policy).Statement : statement
        if statement.Sid == "StateLock"
      ]).Action == ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.deploy_state[0].policy).Statement : statement
        if statement.Sid == "StateLock"
      ]).Resource == "${aws_s3_bucket.state.arn}/hono-starter-kit/dev/terraform.tfstate.tflock" &&
      aws_iam_role_policy.plan_state[0].policy != aws_iam_role_policy.deploy_state[0].policy
    )
    error_message = "Plan and deploy must have exact, distinct state access while sharing exact native-lock permissions."
  }

  assert {
    condition = (
      alltrue([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : (
          statement.Sid != "FoundationRead" &&
          (
            statement.Sid == "CloudFrontCreateUnscoped" ||
            try(statement.Resource, "*") != "*" ||
            length(keys(try(statement.Condition, {}))) > 0
          )
        )
      ])
    )
    error_message = "Deploy mutations must exclude refresh reads and use tag conditions, resource-name prefixes, or exact ARNs."
  }

  assert {
    condition = alltrue(flatten([
      for statement in jsondecode(local.deploy_foundation_policy).Statement : [
        for resource in flatten([statement.Resource]) : (
          resource != aws_s3_bucket.state.arn &&
          (!endswith(resource, "*") || !startswith(aws_s3_bucket.state.arn, trimsuffix(resource, "*")))
        )
        ] if statement.Effect == "Allow" && anytrue([
          for action in statement.Action : startswith(action, "s3:") && !contains([
            "s3:GetBucketLocation",
            "s3:GetBucketOwnershipControls",
            "s3:GetBucketPolicy",
            "s3:GetBucketPublicAccessBlock",
            "s3:GetBucketTagging",
            "s3:GetBucketVersioning",
            "s3:GetEncryptionConfiguration",
            "s3:ListAllMyBuckets",
            "s3:ListBucket",
          ], action)
      ])
    ]))
    error_message = "No foundation mutation allow may match the exact Terraform state bucket ARN."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(local.deploy_foundation_policy).Statement : (
        !anytrue([
          for action in statement.Action : contains([
            "ec2:CreateTags",
            "cloudfront:TagResource",
            "cognito-idp:TagResource",
          ], action)
          ]) || (
          !contains(flatten([statement.Resource]), "*") && (
            try(statement.Condition.StringEquals["ec2:CreateAction"], null) != null || (
              try(statement.Condition.StringEquals["aws:ResourceTag/Project"], null) == var.project &&
              try(statement.Condition.StringEquals["aws:ResourceTag/Environment"], null) == var.environment
            )
          )
        )
      )
    ])
    error_message = "Standalone tag permissions must be limited to create context or already-owned scoped resources."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "Ec2TagOnCreate"
      ]).Action == ["ec2:CreateTags"] &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "Ec2TagOnCreate"
        ]).Condition.StringEquals["ec2:CreateAction"] == [
        "AllocateAddress",
        "CreateInternetGateway",
        "CreateNatGateway",
        "CreateRouteTable",
        "CreateSecurityGroup",
        "CreateSubnet",
        "CreateVpc",
      ] &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "Ec2TagExisting"
      ]).Action == ["ec2:CreateTags", "ec2:DeleteTags"] &&
      contains(one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "CloudFrontMutateTagged"
      ]).Action, "cloudfront:TagResource") &&
      contains(one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "CognitoMutateTagged"
      ]).Action, "cognito-idp:TagResource")
    )
    error_message = "Creation tagging and existing-resource tagging must use distinct guarded statements."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "CloudFrontCreateTagged"
        ]).Action == [
        "cloudfront:CreateDistribution",
        "cloudfront:CreateFunction",
        "cloudfront:CreateVpcOrigin",
      ] &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "CognitoCreateTagged"
      ]).Action == ["cognito-idp:CreateUserPool"]
    )
    error_message = "Request-tag conditions must be attached only to supported CloudFront and Cognito create actions."
  }

  assert {
    condition = (
      output.github_plan_role_arn == aws_iam_role.plan[0].arn &&
      output.github_deploy_role_arn == aws_iam_role.deploy[0].arn
    )
    error_message = "Bootstrap outputs must expose both GitHub role ARNs."
  }
}

run "overlapping_state_bucket_is_explicitly_denied" {
  command = plan

  variables {
    state_bucket_name = "hono-starter-kit-dev-web-state"
  }

  override_resource {
    target          = aws_s3_bucket.state
    override_during = plan
    values = {
      arn = "arn:aws:s3:::hono-starter-kit-dev-web-state"
      id  = "hono-starter-kit-dev-web-state"
    }
  }

  assert {
    condition = anytrue(flatten([
      for statement in jsondecode(local.deploy_foundation_policy).Statement : [
        for resource in flatten([statement.Resource]) : (
          statement.Effect == "Allow" &&
          contains(statement.Action, "s3:DeleteBucketPolicy") &&
          (
            resource == aws_s3_bucket.state.arn ||
            (endswith(resource, "*") && startswith(aws_s3_bucket.state.arn, trimsuffix(resource, "*")))
          )
        )
      ]
    ]))
    error_message = "The overlap fixture must exercise a foundation mutation allow that matches the configured state bucket."
  }

  assert {
    condition = try(
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "DenyStateBucketFoundationMutation"
      ]).Effect == "Deny" &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "DenyStateBucketFoundationMutation"
        ]).Action == [
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
      ] &&
      one([
        for statement in jsondecode(local.deploy_foundation_policy).Statement : statement
        if statement.Sid == "DenyStateBucketFoundationMutation"
      ]).Resource == "arn:aws:s3:::hono-starter-kit-dev-web-state"
    , false)
    error_message = "Every S3 foundation mutation must be explicitly denied on the exact configured state bucket ARN."
  }
}

run "existing_provider_is_reused" {
  command = plan

  variables {
    create_github_plan_role     = true
    create_github_deploy_role   = true
    create_github_oidc_provider = false
    github_oidc_provider_arn    = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }

  assert {
    condition = (
      length(aws_iam_openid_connect_provider.github) == 0 &&
      one(jsondecode(aws_iam_role.plan[0].assume_role_policy).Statement).Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" &&
      one(jsondecode(aws_iam_role.deploy[0].assume_role_policy).Statement).Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    )
    error_message = "Reuse mode must trust only the supplied GitHub OIDC provider ARN."
  }
}

run "both_provider_modes_are_rejected" {
  command = plan

  variables {
    create_github_plan_role     = true
    create_github_deploy_role   = true
    create_github_oidc_provider = true
    github_oidc_provider_arn    = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }

  expect_failures = [
    check.github_oidc_provider_mode,
    aws_iam_role.plan,
    aws_iam_role.deploy,
  ]
}

run "missing_provider_mode_is_rejected" {
  command = plan

  variables {
    create_github_plan_role     = true
    create_github_deploy_role   = true
    create_github_oidc_provider = false
    github_oidc_provider_arn    = null
  }

  expect_failures = [
    check.github_oidc_provider_mode,
    aws_iam_role.plan,
    aws_iam_role.deploy,
  ]
}

run "provider_mode_is_checked_when_roles_are_disabled" {
  command = plan

  variables {
    create_github_oidc_provider = false
    github_oidc_provider_arn    = null
  }

  expect_failures = [
    check.github_oidc_provider_mode,
  ]
}

run "plan_role_alone_creates_shared_resources_only" {
  command = plan

  variables {
    create_github_plan_role = true
  }

  assert {
    condition = (
      length(aws_iam_role.plan) == 1 &&
      length(aws_iam_role.deploy) == 0 &&
      length(aws_iam_openid_connect_provider.github) == 1 &&
      length(aws_iam_policy.foundation_read) == 1 &&
      length(aws_iam_policy.workload_read) == 1 &&
      length(aws_iam_policy.deploy_foundation_network) == 0 &&
      length(aws_iam_policy.deploy_foundation_services) == 0 &&
      length(aws_iam_role_policy.plan_state) == 1 &&
      length(aws_iam_role_policy.deploy_state) == 0 &&
      length(aws_iam_role_policy.deploy_foundation) == 0 &&
      length(aws_iam_role_policy.deploy_workload) == 0 &&
      output.github_plan_role_arn != null &&
      output.github_deploy_role_arn == null
    )
    error_message = "plan role だけを有効にしたとき、共有 policy と provider は作り、deploy role とその policy は作ってはならない。"
  }
}

run "deploy_role_alone_creates_shared_resources_only" {
  command = plan

  variables {
    create_github_deploy_role = true
  }

  assert {
    condition = (
      length(aws_iam_role.plan) == 0 &&
      length(aws_iam_role.deploy) == 1 &&
      length(aws_iam_openid_connect_provider.github) == 1 &&
      length(aws_iam_policy.foundation_read) == 1 &&
      length(aws_iam_policy.workload_read) == 1 &&
      length(aws_iam_policy.deploy_foundation_network) == 1 &&
      length(aws_iam_policy.deploy_foundation_services) == 1 &&
      length(aws_iam_role_policy.plan_state) == 0 &&
      length(aws_iam_role_policy.deploy_state) == 1 &&
      output.github_plan_role_arn == null &&
      output.github_deploy_role_arn != null
    )
    error_message = "deploy role だけを有効にしたとき、共有 policy と provider は作り、plan role は作ってはならない。"
  }
}

run "deploy_role_alone_rejects_invalid_provider_mode" {
  command = plan

  variables {
    create_github_deploy_role   = true
    create_github_oidc_provider = false
    github_oidc_provider_arn    = null
  }

  expect_failures = [
    check.github_oidc_provider_mode,
    aws_iam_role.deploy,
  ]
}

run "foundation_defaults_refuse_destructive_removal" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.force_destroy == false
    error_message = "固定した値（= 既定値。isolation テストが一致を保証する）で、空でない state bucket の destroy を拒否すること。"
  }

  assert {
    condition     = aws_ecr_repository.api.force_delete == false
    error_message = "固定した値（= 既定値。isolation テストが一致を保証する）で、空でない API repository の delete を拒否すること。"
  }
}

run "release_values_allow_foundation_removal" {
  command = plan

  variables {
    state_bucket_force_destroy = true
    ecr_force_delete           = true
  }

  assert {
    condition     = aws_s3_bucket.state.force_destroy == true
    error_message = "The release value must allow destroying a non-empty state bucket."
  }

  assert {
    condition     = aws_ecr_repository.api.force_delete == true
    error_message = "The release value must allow deleting a non-empty repository."
  }
}

run "rejects_empty_aws_account_id" {
  command = plan

  variables {
    aws_account_id = ""
  }

  expect_failures = [var.aws_account_id]
}

run "rejects_short_aws_account_id" {
  command = plan

  variables {
    aws_account_id = "12345678901"
  }

  expect_failures = [var.aws_account_id]
}

run "rejects_long_aws_account_id" {
  command = plan

  variables {
    aws_account_id = "1234567890123"
  }

  expect_failures = [var.aws_account_id]
}

run "rejects_nonnumeric_aws_account_id" {
  command = plan

  variables {
    aws_account_id = "12345678901a"
  }

  expect_failures = [var.aws_account_id]
}
