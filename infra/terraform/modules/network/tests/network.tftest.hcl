mock_provider "aws" {}

variables {
  project            = "hono-starter-kit"
  environment        = "dev"
  vpc_cidr           = "10.0.0.0/16"
  availability_zones = ["ap-northeast-1a", "ap-northeast-1c"]
  app_port           = 3000
}

run "two_az_topology_is_private_and_ordered" {
  command = plan

  override_data {
    override_during = plan
    target          = data.aws_ec2_managed_prefix_list.cloudfront
    values = {
      id = "pl-cloudfront"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_vpc.this
    values = {
      id = "vpc-network"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_internet_gateway.this
    values = {
      id = "igw-network"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_nat_gateway.this[0]
    values = {
      id = "nat-network"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_subnet.public[0]
    values = {
      id = "subnet-public-a"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_subnet.public[1]
    values = {
      id = "subnet-public-c"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_subnet.app[0]
    values = {
      id = "subnet-app-a"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_subnet.app[1]
    values = {
      id = "subnet-app-c"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_subnet.db[0]
    values = {
      id = "subnet-db-a"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_subnet.db[1]
    values = {
      id = "subnet-db-c"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_route_table.public[0]
    values = {
      id = "rtb-public-a"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_route_table.public[1]
    values = {
      id = "rtb-public-c"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_route_table.app[0]
    values = {
      id = "rtb-app-a"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_route_table.app[1]
    values = {
      id = "rtb-app-c"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_route_table.db[0]
    values = {
      id = "rtb-db-a"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_route_table.db[1]
    values = {
      id = "rtb-db-c"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_security_group.alb
    values = {
      id = "sg-alb"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_security_group.task
    values = {
      id = "sg-task"
    }
  }

  override_resource {
    override_during = plan
    target          = aws_security_group.rds
    values = {
      id = "sg-rds"
    }
  }

  assert {
    condition = (
      aws_vpc.this.cidr_block == "10.0.0.0/16" &&
      aws_vpc.this.enable_dns_support &&
      aws_vpc.this.enable_dns_hostnames
    )
    error_message = "The VPC must use the requested /16 with DNS support and hostnames enabled."
  }

  assert {
    condition = (
      length(aws_subnet.public) == 2 &&
      length(aws_subnet.app) == 2 &&
      length(aws_subnet.db) == 2 &&
      length(concat(aws_subnet.public, aws_subnet.app, aws_subnet.db)) == 6
    )
    error_message = "The module must create exactly two public, two app, and two DB subnets."
  }

  assert {
    condition = alltrue([
      for index, availability_zone in var.availability_zones :
      aws_subnet.public[index].availability_zone == availability_zone &&
      aws_subnet.app[index].availability_zone == availability_zone &&
      aws_subnet.db[index].availability_zone == availability_zone
    ])
    error_message = "Every subnet tier must follow the two explicit availability zones in input order."
  }

  assert {
    condition = (
      join(",", aws_subnet.public[*].cidr_block) == "10.0.0.0/24,10.0.1.0/24" &&
      join(",", aws_subnet.app[*].cidr_block) == "10.0.16.0/24,10.0.17.0/24" &&
      join(",", aws_subnet.db[*].cidr_block) == "10.0.32.0/24,10.0.33.0/24"
    )
    error_message = "Subnet CIDRs must be derived deterministically for public, app, and DB tiers."
  }

  assert {
    condition = (
      alltrue(aws_subnet.public[*].map_public_ip_on_launch) &&
      !anytrue(aws_subnet.app[*].map_public_ip_on_launch) &&
      !anytrue(aws_subnet.db[*].map_public_ip_on_launch)
    )
    error_message = "Only public subnets may map public IP addresses on launch."
  }

  assert {
    condition = (
      length(aws_nat_gateway.this) == 1 &&
      aws_nat_gateway.this[0].subnet_id == "subnet-public-a"
    )
    error_message = "Exactly one NAT Gateway must be placed in the first public subnet."
  }

  assert {
    condition = alltrue([
      for index in range(2) :
      aws_route.public_default[index].route_table_id == ["rtb-public-a", "rtb-public-c"][index] &&
      aws_route.public_default[index].destination_cidr_block == "0.0.0.0/0" &&
      aws_route.public_default[index].gateway_id == "igw-network"
    ])
    error_message = "Both public route tables must use the Internet Gateway for their default route."
  }

  assert {
    condition = alltrue([
      for index in range(2) :
      aws_route.app_default[index].route_table_id == ["rtb-app-a", "rtb-app-c"][index] &&
      aws_route.app_default[index].destination_cidr_block == "0.0.0.0/0" &&
      aws_route.app_default[index].nat_gateway_id == "nat-network"
    ])
    error_message = "Both app route tables must use the single NAT Gateway for their default route."
  }

  assert {
    condition = (
      alltrue([for route_table in aws_route_table.db : try(length(route_table.route), 0) == 0]) &&
      alltrue([
        for index in range(2) :
        aws_route_table_association.db[index].route_table_id == ["rtb-db-a", "rtb-db-c"][index]
      ])
    )
    error_message = "DB route tables must be associated with DB subnets and contain no Internet or NAT route."
  }

  assert {
    condition = (
      aws_vpc.this.tags == tomap({
        Project     = "hono-starter-kit"
        Environment = "dev"
        ManagedBy   = "Terraform"
        }) && alltrue(concat(
        [
          aws_internet_gateway.this.tags == aws_vpc.this.tags,
          aws_eip.nat.tags == aws_vpc.this.tags,
          aws_nat_gateway.this[0].tags == aws_vpc.this.tags,
        ],
        [for subnet in concat(aws_subnet.public, aws_subnet.app, aws_subnet.db) : subnet.tags == aws_vpc.this.tags],
        [for route_table in concat(aws_route_table.public, aws_route_table.app, aws_route_table.db) : route_table.tags == aws_vpc.this.tags],
        [
          aws_security_group.alb.tags == aws_vpc.this.tags,
          aws_security_group.task.tags == aws_vpc.this.tags,
          aws_security_group.rds.tags == aws_vpc.this.tags,
        ]
      ))
    )
    error_message = "Every taggable topology resource must carry the exact project, environment, and management tags."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.alb_cloudfront.security_group_id == "sg-alb" &&
      aws_vpc_security_group_ingress_rule.alb_cloudfront.prefix_list_id == "pl-cloudfront" &&
      aws_vpc_security_group_ingress_rule.alb_cloudfront.ip_protocol == "tcp" &&
      aws_vpc_security_group_ingress_rule.alb_cloudfront.from_port == 80 &&
      aws_vpc_security_group_ingress_rule.alb_cloudfront.to_port == 80
    )
    error_message = "Only the CloudFront origin-facing prefix list may enter the ALB on TCP 80."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.task_from_alb.security_group_id == "sg-task" &&
      aws_vpc_security_group_ingress_rule.task_from_alb.referenced_security_group_id == "sg-alb" &&
      aws_vpc_security_group_ingress_rule.task_from_alb.ip_protocol == "tcp" &&
      aws_vpc_security_group_ingress_rule.task_from_alb.from_port == 3000 &&
      aws_vpc_security_group_ingress_rule.task_from_alb.to_port == 3000
    )
    error_message = "Only the ALB security group may enter tasks on app_port."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.rds_from_task.security_group_id == "sg-rds" &&
      aws_vpc_security_group_ingress_rule.rds_from_task.referenced_security_group_id == "sg-task" &&
      aws_vpc_security_group_ingress_rule.rds_from_task.ip_protocol == "tcp" &&
      aws_vpc_security_group_ingress_rule.rds_from_task.from_port == 5432 &&
      aws_vpc_security_group_ingress_rule.rds_from_task.to_port == 5432
    )
    error_message = "Only the task security group may enter RDS on PostgreSQL TCP 5432."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.alb_to_task.security_group_id == "sg-alb" &&
      aws_vpc_security_group_egress_rule.alb_to_task.referenced_security_group_id == "sg-task" &&
      aws_vpc_security_group_egress_rule.alb_to_task.from_port == 3000 &&
      aws_vpc_security_group_egress_rule.alb_to_task.to_port == 3000 &&
      aws_vpc_security_group_egress_rule.alb_to_task.ip_protocol == "tcp"
    )
    error_message = "ALB egress must be limited to the task security group on app_port."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.task_to_rds.security_group_id == "sg-task" &&
      aws_vpc_security_group_egress_rule.task_to_rds.referenced_security_group_id == "sg-rds" &&
      aws_vpc_security_group_egress_rule.task_to_rds.from_port == 5432 &&
      aws_vpc_security_group_egress_rule.task_to_rds.to_port == 5432 &&
      aws_vpc_security_group_egress_rule.task_to_rds.ip_protocol == "tcp"
    )
    error_message = "Task PostgreSQL egress must be limited to the RDS security group."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.task_https.security_group_id == "sg-task" &&
      aws_vpc_security_group_egress_rule.task_https.cidr_ipv4 == "0.0.0.0/0" &&
      aws_vpc_security_group_egress_rule.task_https.from_port == 443 &&
      aws_vpc_security_group_egress_rule.task_https.to_port == 443 &&
      aws_vpc_security_group_egress_rule.task_https.ip_protocol == "tcp"
    )
    error_message = "Tasks must have HTTPS egress without a wider Internet rule."
  }

  assert {
    condition = alltrue([
      aws_vpc_security_group_egress_rule.task_dns_tcp.security_group_id == "sg-task",
      aws_vpc_security_group_egress_rule.task_dns_tcp.cidr_ipv4 == "10.0.0.0/16",
      aws_vpc_security_group_egress_rule.task_dns_tcp.from_port == 53,
      aws_vpc_security_group_egress_rule.task_dns_tcp.to_port == 53,
      aws_vpc_security_group_egress_rule.task_dns_tcp.ip_protocol == "tcp",
      aws_vpc_security_group_egress_rule.task_dns_udp.security_group_id == "sg-task",
      aws_vpc_security_group_egress_rule.task_dns_udp.cidr_ipv4 == "10.0.0.0/16",
      aws_vpc_security_group_egress_rule.task_dns_udp.from_port == 53,
      aws_vpc_security_group_egress_rule.task_dns_udp.to_port == 53,
      aws_vpc_security_group_egress_rule.task_dns_udp.ip_protocol == "udp",
    ])
    error_message = "Tasks must have only TCP and UDP DNS egress to the VPC CIDR on port 53."
  }

  assert {
    condition = (
      try(length(aws_security_group.alb.ingress), 0) == 0 &&
      try(length(aws_security_group.alb.egress), 0) == 0 &&
      try(length(aws_security_group.task.ingress), 0) == 0 &&
      try(length(aws_security_group.task.egress), 0) == 0 &&
      try(length(aws_security_group.rds.ingress), 0) == 0 &&
      try(length(aws_security_group.rds.egress), 0) == 0
    )
    error_message = "Security groups must use standalone rule resources and RDS must have no egress."
  }

  assert {
    condition = (
      output.vpc_id == "vpc-network" &&
      join(",", output.public_subnet_ids) == "subnet-public-a,subnet-public-c" &&
      join(",", output.private_app_subnet_ids) == "subnet-app-a,subnet-app-c" &&
      join(",", output.private_db_subnet_ids) == "subnet-db-a,subnet-db-c" &&
      output.alb_security_group_id == "sg-alb" &&
      output.task_security_group_id == "sg-task" &&
      output.rds_security_group_id == "sg-rds"
    )
    error_message = "Module outputs must preserve input-AZ order and expose the three security groups."
  }
}

run "rejects_one_availability_zone" {
  command = plan

  variables {
    availability_zones = ["ap-northeast-1a"]
  }

  expect_failures = [var.availability_zones]
}

run "rejects_three_availability_zones" {
  command = plan

  variables {
    availability_zones = ["ap-northeast-1a", "ap-northeast-1c", "ap-northeast-1d"]
  }

  expect_failures = [var.availability_zones]
}

run "rejects_duplicate_availability_zones" {
  command = plan

  variables {
    availability_zones = ["ap-northeast-1a", "ap-northeast-1a"]
  }

  expect_failures = [var.availability_zones]
}

run "rejects_non_sixteen_bit_vpc_cidr" {
  command = plan

  variables {
    vpc_cidr = "10.0.0.0/20"
  }

  expect_failures = [var.vpc_cidr]
}

run "rejects_malformed_vpc_cidr" {
  command = plan

  variables {
    vpc_cidr = "not-a-cidr"
  }

  expect_failures = [var.vpc_cidr]
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
