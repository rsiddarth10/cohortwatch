variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Environment name (prod, staging)"
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.40.0.0/16"
}

variable "azs" {
  description = "Availability zones (3 for MSK and EKS spread)"
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
}

variable "eks_version" {
  description = "EKS Kubernetes version"
  type        = string
  default     = "1.31"
}

variable "app_node_instance_type" {
  description = "Instance type for the app node group (normaliser, state processor, API, ...)"
  type        = string
  default     = "m6i.xlarge"
}

variable "app_node_count" {
  description = "Desired app nodes (min/max are derived)"
  type        = number
  default     = 6
}

variable "db_node_instance_type" {
  description = "Instance type for the TimescaleDB node group (memory-heavy)"
  type        = string
  default     = "r6i.xlarge"
}

variable "msk_broker_instance_type" {
  description = "MSK broker instance type"
  type        = string
  default     = "kafka.m5.large"
}

variable "msk_broker_volume_gb" {
  description = "EBS per MSK broker (3-day raw retention at 100K vans ≈ 1.5 TB replicated / 3 brokers)"
  type        = number
  default     = 1000
}

variable "redis_node_type" {
  description = "ElastiCache node type (anti-replay state + checkpoints, ~2 GB at 100K vans)"
  type        = string
  default     = "cache.r7g.large"
}

variable "lake_bucket_name" {
  description = "S3 bucket for the history lake (must be globally unique)"
  type        = string
  default     = "cohortwatch-lake-prod"
}
