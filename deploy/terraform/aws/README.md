# Terraform: CohortWatch on AWS (reference, not applied)

`terraform fmt -check` and `terraform validate` pass (`hashicorp/terraform:1.9.8`, AWS provider `~> 5.70`, lock file committed).
**Nothing has been applied.** This is the production shape of the laptop stack. The app services deploy with
[the Helm chart](../../helm/cohortwatch).

```bash
terraform init -backend-config=env/prod.s3.tfbackend   # S3 state + DynamoDB lock, per environment
terraform plan -out plan.tfplan && terraform apply plan.tfplan
```

## What it creates

| Area | Resources | Security |
|---|---|---|
| Network | VPC, 3 public + 3 private subnets over 3 AZs, NAT gateway, S3 gateway endpoint | Stores in private subnets only. Security groups allow Kafka (9094) and Redis (6379) from the EKS nodes only |
| Kubernetes | EKS 1.31 (private + public endpoint), app node group (6 × m6i.xlarge), TimescaleDB node group (2 × r6i.xlarge, tainted), EBS CSI add-on, OIDC provider (IRSA) | Kubernetes secrets envelope-encrypted with KMS; audit logs on |
| Kafka | Amazon MSK 3.6 (3 × kafka.m5.large, 1 TB each), `auto.create.topics=false`, RF 3, min ISR 2 | TLS in transit (client and in-cluster), KMS at rest. Client auth: **mTLS for the OEM feeds** (device-free ingestion, ADR 0023), IAM for the services |
| Redis | ElastiCache Redis 7.1, primary + replica, multi-AZ | TLS in transit, KMS at rest |
| Lake | S3 bucket (history Parquet), versioned, lifecycle to Infrequent Access after 30 days | SSE-KMS, public access blocked, TLS-only bucket policy |
| Secrets | Secrets Manager: `cohortwatch/database-url-app`, `…-api`, `redis-url` (values set outside Terraform) | KMS-encrypted. Read only by the External Secrets IRSA role |
| IAM | IRSA roles: external-secrets (read those secrets), lake (read/write the bucket) | Least privilege, scoped to service accounts |
| Keys | One customer-managed KMS key, yearly rotation | Used by EKS, EBS, MSK, ElastiCache, S3, Secrets Manager |

## Decision: TimescaleDB is self-managed on EKS (not RDS)

The core schema needs the **TimescaleDB extension**: the hourly telemetry hypertable, compression and the continuous
aggregate behind the vehicle chart. **Amazon RDS for PostgreSQL does not offer TimescaleDB.** Options:
1. **Self-managed TimescaleDB on EKS** (chosen here): a StatefulSet (Timescale's Helm chart or the same
   `timescaledb-ha` image as compose) with a primary and a streaming replica. It runs on the dedicated `timescale`
   node group, on KMS-encrypted gp3 volumes, with WAL archiving and base backups to the S3 lake bucket.
   - Pros: same image as dev, stays in the VPC, no extra vendor.
   - Cons: we run failover, upgrades and backups ourselves.
2. **Timescale Cloud on AWS** (same region, VPC peering): managed HA, backups and upgrades, at a higher price and
   with a second vendor. A good choice if the team does not want to operate a database.

RDS stays an option only if the hypertables were replaced by native partitioning and the continuous aggregate by
a materialized view. That is a schema change, not an infrastructure one.

## Rough monthly cost: 100K vans

On-demand list prices in `ap-south-1` (Mumbai), rounded. **Rough: ±30%, check the AWS pricing calculator.**
Savings Plans or reserved capacity usually cut compute by 30–50%.

| Item | Size | ≈ USD / month |
|---|---|---|
| EKS control plane | 1 cluster | 75 |
| App nodes | 6 × m6i.xlarge (4 vCPU, 16 GB) | 880 |
| TimescaleDB nodes | 2 × r6i.xlarge (4 vCPU, 32 GB) | 370 |
| TimescaleDB storage | 2 × 1 TB gp3 + snapshots | 220 |
| MSK brokers | 3 × kafka.m5.large | 500 |
| MSK storage | 3 × 1 TB (3-day raw retention, RF 3) | 330 |
| ElastiCache | 2 × cache.r7g.large | 320 |
| NAT gateway + data | 1 NAT, light egress (images, OIDC) | 60 |
| S3 lake | ~1.5 TB history Parquet, IA after 30 d | 40 |
| KMS, Secrets Manager, CloudWatch logs | | 50 |
| **Total** | | **≈ 2,850 / month** (≈ USD 0.03 per van per month) |

**Sizing basis** (measured on the laptop):
- **Ingest:** ~10K msgs/s at 100K vans in demo mode; the 3× shift surge was measured (docs/perf/state-processor.md).
- **Replica counts:** 3 normaliser and 3 state-processor replicas as the HPA floor. In the 100K measurements they
  fell behind only during the surge, so the HPA ceiling is 12.
- **Postgres:** the hourly telemetry is ~2.4M rows per day at 100K; 90-day retention with compression fits well
  inside 1 TB.
