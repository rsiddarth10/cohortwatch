# ADR 0003: Canonical events are Avro via the Redpanda schema registry

- **Status:** accepted (S2, 2026-09-29)
- **Context:** the brief asks for Avro via the registry on `telemetry.canonical.v1`. The S2 plan allowed a JSON
  fallback if the registry client took more than 20 minutes to get working. It did not: the Avro path worked on
  the first integration run.

**Decision.**
- The schema (`services/normaliser/src/avro.ts`) is registered at start-up under subject
  `telemetry.canonical.v1-value` with compatibility **BACKWARD**, using `@kafkajs/confluent-schema-registry`.
- Records are encoded **synchronously** with `avsc` into the Confluent wire format (magic byte + 4-byte schema id
  + body). The registry client's own `encode()` is async per message and was not needed on the hot path.
- `source_format` is a string, not an Avro enum: enum symbols cannot contain `.`, and a new OEM format must not
  break old readers.
- A unit test keeps the Avro fields identical to the zod contract in `packages/domain`.
- `ENCODING=json` (zod-validated JSON) remains as a documented fallback, but it is not the default.

**Consequences.**
- Consumers (S3 on) decode with any Confluent-compatible deserializer, and the Redpanda Console shows decoded
  events.
- Schema evolution is guarded by the registry: a non-BACKWARD change fails at normaliser start-up, not in
  production reads.
