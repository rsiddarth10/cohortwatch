# Architecture decision records

| ADR | Decision | Step |
|---|---|---|
| [0001](0001-normaliser-anti-replay-and-delivery.md) | Normaliser anti-replay window and delivery order | S2 |
| [0002](0002-clock-skew-against-ingest-time.md) | Clock skew is judged against ingest time mapped into event time | S2 |
| [0003](0003-canonical-avro-via-schema-registry.md) | Canonical events are Avro via the Redpanda schema registry | S2 |
| [0004](0004-normaliser-back-pressure.md) | Normaliser back-pressure thresholds | S2 |
| [0005](0005-state-in-memory-redis-checkpoint.md) | Detection state in memory per partition, checkpointed to Redis | S3 |
| [0006](0006-sampled-peer-context.md) | Peer context is a per-replica sampled estimate, with a region-wide fallback | S3 |
| [0007](0007-baseline-batch-job-language.md) | The baseline batch job is Python 3.12 + DuckDB | S3 |
| [0008](0008-telemetry-down-sampling.md) | Telemetry is down-sampled to one row per van per sim-hour | S3 |
| [0009](0009-campaign-family-key.md) | The campaign family key is fault family \| model \| duty \| depot | S5 |
| [0010](0010-poisson-guard-regional-rate.md) | Poisson guard with a regional expected rate | S5 |
| [0011](0011-at-risk-score-source.md) | At-risk scores are stored in the hourly telemetry rows | S5 |
| [0012](0012-transactional-outbox.md) | Campaign events leave through a transactional outbox | S5 |
| [0013](0013-past-campaigns-feature-vectors.md) | Similar past campaigns: synthetic cases and feature-vector cosine similarity | S5 |
| [0014](0014-queue-scoring-behaviour-cap.md) | Queue scoring, runaway pinning and the behaviour cap | S4 |
| [0015](0015-in-service-tomorrow-source.md) | "In service tomorrow" comes from the registry flags | S4 |
| [0016](0016-repair-resets-trend.md) | A repair resets the van's trend in the state processor | S6 |
| [0017](0017-fix-confirmation-rule.md) | Fix confirmation is judged on post-repair driven hours | S6 |
| [0018](0018-local-oidc-issuer.md) | A local OIDC issuer (oidc-provider) with JWT access tokens | S7 |
| [0019](0019-rls-and-masking.md) | Tenant isolation by Postgres RLS; viewer masking in the API | S7 |
| [0020](0020-template-agent.md) | A template agent (no LLM), with proposals that only a lead approves | S8 |
| [0021](0021-sse-over-websocket.md) | Server-Sent Events (not WebSocket) for the live board | S7 |
| [0022](0022-batched-queue-tick.md) | The hourly queue tick reads the whole fleet in one batch and writes only changed depots | S9 |
| [0023](0023-device-free-ingestion.md) | Device-free ingestion: OEM cloud feeds over Kafka, no MQTT, no on-vehicle agent | S1a (recorded S10) |
| [0024](0024-node-over-python.md) | Node.js (TypeScript) for the services; Python only for batch and ML | S1a (recorded S10) |

Kafka client fallback rule (brief §2.3): not triggered; `@confluentinc/kafka-javascript` installed and ran from S1a.
