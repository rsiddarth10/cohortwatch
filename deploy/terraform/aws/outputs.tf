output "eks_cluster_name" {
  value = aws_eks_cluster.main.name
}

output "msk_bootstrap_brokers_tls" {
  description = "Helm values: external.kafkaBrokers"
  value       = aws_msk_cluster.main.bootstrap_brokers_tls
}

output "redis_primary_endpoint" {
  description = "Goes into the cohortwatch/redis-url secret (rediss://...)"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "lake_bucket" {
  value = aws_s3_bucket.lake.bucket
}

output "kms_key_arn" {
  value = aws_kms_key.data.arn
}

output "external_secrets_role_arn" {
  description = "Annotate the external-secrets service account with this role (IRSA)"
  value       = aws_iam_role.external_secrets.arn
}

output "account_id" {
  value = data.aws_caller_identity.current.account_id
}
