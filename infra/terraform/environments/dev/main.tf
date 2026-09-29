data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  availability_zones = slice(sort(data.aws_availability_zones.available.names), 0, 2)
}

module "network" {
  source = "../../modules/network"

  project            = var.project
  environment        = var.environment
  vpc_cidr           = var.vpc_cidr
  availability_zones = local.availability_zones
  app_port           = var.app_port
}

module "data" {
  source = "../../modules/data"

  project               = var.project
  environment           = var.environment
  db_subnet_ids         = module.network.private_db_subnet_ids
  rds_security_group_id = module.network.rds_security_group_id
  database_name         = var.database_name
  deletion_protection   = var.database_deletion_protection
  skip_final_snapshot   = var.database_skip_final_snapshot
}

module "ingress" {
  source = "../../modules/ingress"

  project                = var.project
  environment            = var.environment
  vpc_id                 = module.network.vpc_id
  private_app_subnet_ids = module.network.private_app_subnet_ids
  alb_security_group_id  = module.network.alb_security_group_id
  app_port               = var.app_port
  deletion_protection    = var.alb_deletion_protection
}

module "edge" {
  source = "../../modules/edge"

  project       = var.project
  environment   = var.environment
  alb_arn       = module.ingress.alb_arn
  alb_dns_name  = module.ingress.alb_dns_name
  force_destroy = var.web_bucket_force_destroy
}

module "identity" {
  source = "../../modules/identity"

  project             = var.project
  environment         = var.environment
  aws_region          = var.aws_region
  app_origin          = module.edge.app_origin
  domain_prefix       = var.domain_prefix
  deletion_protection = var.identity_deletion_protection
}

module "workload" {
  source = "../../modules/workload"

  project                = var.project
  environment            = var.environment
  aws_region             = var.aws_region
  private_app_subnet_ids = module.network.private_app_subnet_ids
  task_security_group_id = module.network.task_security_group_id
  target_group_arn       = module.ingress.target_group_arn
  app_port               = var.app_port
  api_image              = var.api_image
  api_repository_arn     = var.api_repository_arn
  adot_image             = var.adot_image
  database_endpoint      = module.data.database_endpoint
  database_port          = module.data.database_port
  database_name          = module.data.database_name
  database_secret_arn    = module.data.database_secret_arn
  app_origin             = module.edge.app_origin
  oidc_issuer            = module.identity.oidc_issuer
  oidc_client_id         = module.identity.oidc_client_id
  oidc_logout_endpoint   = module.identity.oidc_logout_endpoint
  task_cpu               = var.task_cpu
  task_memory            = var.task_memory

  depends_on = [module.ingress]
}
