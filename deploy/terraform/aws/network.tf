# VPC: 3 public subnets (load balancer, NAT) and 3 private subnets (EKS nodes, MSK, ElastiCache). Nothing stateful
# is reachable from the internet.
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "cohortwatch-${var.environment}" }
}

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.main.id
  availability_zone       = var.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = false
  tags = {
    Name                     = "cohortwatch-public-${var.azs[count.index]}"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.main.id
  availability_zone = var.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 1)
  tags = {
    Name                              = "cohortwatch-private-${var.azs[count.index]}"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# S3 traffic stays on the AWS network (gateway endpoint, no NAT charges for the lake).
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}

# Security group for the EKS nodes; the managed stores only accept traffic from it.
resource "aws_security_group" "nodes" {
  name_prefix = "cohortwatch-nodes-"
  vpc_id      = aws_vpc.main.id
  description = "EKS worker nodes"
  egress {
    description = "inside the VPC: MSK 9094, Postgres 5432, Redis 6379, DNS, node-to-node"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }
  # HTTPS out through the NAT: container images and the OIDC provider's JWKS. The destinations are external
  # services without fixed IPs, so the CIDR cannot be narrower. Kubernetes NetworkPolicies limit which pods use it.
  #trivy:ignore:AVD-AWS-0104
  egress {
    description = "HTTPS to image registries and the OIDC provider (JWKS), via NAT"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    #trivy:ignore:AVD-AWS-0104
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "msk" {
  name_prefix = "cohortwatch-msk-"
  vpc_id      = aws_vpc.main.id
  description = "MSK brokers: TLS 9094 from the nodes only"
  ingress {
    description     = "Kafka TLS from EKS nodes"
    from_port       = 9094
    to_port         = 9094
    protocol        = "tcp"
    security_groups = [aws_security_group.nodes.id]
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "cohortwatch-redis-"
  vpc_id      = aws_vpc.main.id
  description = "ElastiCache: TLS 6379 from the nodes only"
  ingress {
    description     = "Redis TLS from EKS nodes"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.nodes.id]
  }
}
