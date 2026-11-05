terraform {
  required_version = ">= 1.9, < 2.0"
  backend "s3" {}
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" {
  region = var.aws_region
  default_tags { tags = { Project = "oficina", Service = "production", Environment = var.environment } }
}
variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "environment" {
  type    = string
  default = "homolog"
}
locals { name = "oficina-${var.environment}-production" }
resource "aws_dynamodb_table" "production" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  global_secondary_index {
    name            = "pending-index"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
}
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-commands-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "commands" {
  name                       = "${local.name}-commands"
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 10
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 5 })
}
resource "aws_ecr_repository" "production" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}
resource "aws_secretsmanager_secret" "application" {
  name                    = "oficina/${var.environment}/production/application"
  description             = "JSON JWT_SECRET e AUTH_CLIENT_LOOKUP_TOKEN; preencher por canal seguro antes do deploy"
  recovery_window_in_days = 7
}
output "table_name" { value = aws_dynamodb_table.production.name }
output "inbox_queue_url" { value = aws_sqs_queue.commands.url }
output "dlq_url" { value = aws_sqs_queue.dlq.url }
output "ecr_repository_url" { value = aws_ecr_repository.production.repository_url }
output "application_secret_id" { value = aws_secretsmanager_secret.application.name }
