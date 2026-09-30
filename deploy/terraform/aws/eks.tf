# EKS: private API endpoint only (admins reach it through the VPC: VPN or SSM bastion); secrets envelope-encrypted with KMS.
data "aws_iam_policy_document" "eks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eks_cluster" {
  name               = "cohortwatch-eks-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.eks_assume.json
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "main" {
  name     = "cohortwatch-${var.environment}"
  version  = var.eks_version
  role_arn = aws_iam_role.eks_cluster.arn
  vpc_config {
    subnet_ids              = aws_subnet.private[*].id
    security_group_ids      = [aws_security_group.nodes.id]
    endpoint_private_access = true
    endpoint_public_access  = false
  }
  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = aws_kms_key.data.arn
    }
  }
  enabled_cluster_log_types = ["api", "audit", "authenticator"]
  depends_on                = [aws_iam_role_policy_attachment.eks_cluster]
}

data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
}

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "nodes" {
  name               = "cohortwatch-nodes-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
}

resource "aws_iam_role_policy_attachment" "nodes" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
  ])
  role       = aws_iam_role.nodes.name
  policy_arn = each.value
}

# App nodes: the stateless services (Helm chart deploy/helm/cohortwatch).
resource "aws_eks_node_group" "app" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "app"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = [var.app_node_instance_type]
  scaling_config {
    desired_size = var.app_node_count
    min_size     = 3
    max_size     = var.app_node_count * 2
  }
  labels     = { workload = "app" }
  depends_on = [aws_iam_role_policy_attachment.nodes]
}

# TimescaleDB nodes: self-managed TimescaleDB (StatefulSet, primary + replica) on encrypted gp3 volumes.
# RDS for PostgreSQL does not offer the TimescaleDB extension, which the core schema needs (hypertables,
# continuous aggregates). Alternative: Timescale Cloud on AWS via VPC peering (see README).
resource "aws_eks_node_group" "timescale" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "timescale"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = [var.db_node_instance_type]
  scaling_config {
    desired_size = 2
    min_size     = 2
    max_size     = 2
  }
  labels = { workload = "timescale" }
  taint {
    key    = "workload"
    value  = "timescale"
    effect = "NO_SCHEDULE"
  }
  depends_on = [aws_iam_role_policy_attachment.nodes]
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "aws-ebs-csi-driver"
}
