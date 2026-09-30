# ADR 0024: Node.js (TypeScript) for the services; Python only for batch and ML

- **Status:** accepted (recorded in S10; the choice dates from S1a, brief §2)
- **Context:** the streaming services (simulator, normaliser, state processor, campaign engine, workshop, API, agent)
  are I/O-bound: Kafka in and out, Redis, Postgres, HTTP/SSE. The batch baseline job and the ML classifier are
  columnar and numeric. The team writes TypeScript daily, and the web app is TypeScript.

**Decision.**
- **Services in Node 22 + TypeScript (strict)**, as npm workspaces sharing one pure domain package (hexagonal:
  `packages/domain` has no I/O and ≥ 80% test coverage). The domain types are shared end to end: simulator,
  services, API and web read the same definitions.
- **Kafka via `@confluentinc/kafka-javascript`** (librdkafka: idempotent producer, zstd, the same client semantics as
  the Java/Go ecosystem), with a `kafkajs` fallback rule if it failed to install (it did not).
- **Python 3.12 only where it is the better tool:** the baselines batch job (DuckDB over Parquet, ADR 0007) and the
  offline ML job (scikit-learn, S9). They run as one-shot containers and exchange data through Postgres and the lake,
  never through in-process calls.

**Consequences.**
- One language across services, API and UI, with one test runner (Vitest), one linter and shared types.
  Refactors are type-checked end to end.
- CPU-heavy work in a service (the state processor's per-reading maths) stays on one event loop per replica. It is
  scaled by partitions and replicas (measured in docs/perf/state-processor.md), not threads.
- A model trained in Python needs an export path to be served in Node (the S9 model card's next step).
