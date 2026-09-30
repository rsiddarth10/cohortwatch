# One customer-managed KMS key for data at rest: EKS secrets, EBS (TimescaleDB volumes), MSK, ElastiCache, S3,
# Secrets Manager. Rotated yearly.
data "aws_caller_identity" "current" {}

resource "aws_kms_key" "data" {
  description             = "CohortWatch data at rest (${var.environment})"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/cohortwatch-${var.environment}"
  target_key_id = aws_kms_key.data.key_id
}

# Credentials live in Secrets Manager; the Helm chart's ExternalSecret copies them into Kubernetes.
# Terraform creates the secrets (encrypted with the key above) but never their values.
resource "aws_secretsmanager_secret" "app" {
  for_each   = toset(["database-url-app", "database-url-api", "redis-url"])
  name       = "cohortwatch/${each.key}"
  kms_key_id = aws_kms_key.data.arn
}

# IRSA: the External Secrets operator may read only these secrets.
data "aws_iam_policy_document" "external_secrets_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:external-secrets:external-secrets"]
    }
  }
}

resource "aws_iam_role" "external_secrets" {
  name               = "cohortwatch-external-secrets-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.external_secrets_assume.json
}

data "aws_iam_policy_document" "external_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [for s in aws_secretsmanager_secret.app : s.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "external_secrets" {
  role   = aws_iam_role.external_secrets.id
  policy = data.aws_iam_policy_document.external_secrets.json
}

# IRSA: the simulator (demo only) and the baselines job read/write the lake bucket; nothing else can.
data "aws_iam_policy_document" "lake_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }
    condition {
      test     = "StringLike"
      variable = "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:cohortwatch:lake-*"]
    }
  }
}

resource "aws_iam_role" "lake" {
  name               = "cohortwatch-lake-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.lake_assume.json
}

data "aws_iam_policy_document" "lake" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.lake.arn, "${aws_s3_bucket.lake.arn}/*"]
  }
  statement {
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "lake" {
  role   = aws_iam_role.lake.id
  policy = data.aws_iam_policy_document.lake.json
}
