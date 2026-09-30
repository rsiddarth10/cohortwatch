terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
  # Remote state (S3 + DynamoDB lock) is configured per environment with -backend-config; nothing is applied here.
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project     = "cohortwatch"
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}
