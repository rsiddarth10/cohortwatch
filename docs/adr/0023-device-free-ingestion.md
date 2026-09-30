# ADR 0023: Device-free ingestion: OEM cloud feeds over Kafka, no MQTT and no on-vehicle agent

- **Status:** accepted (recorded in S10; the choice dates from S1a)
- **Context:** fleet vans already stream telematics to their manufacturers' clouds (here the fictitious Aurex and
  Kestrel). Putting our own device or agent on 100K vans means hardware, installs, firmware and a device fleet to
  secure. The problem statement asks for insight across mixed OEM fleets, not for a new telematics box.

**Decision.**
- CohortWatch ingests **OEM cloud-to-cloud feeds**: each OEM's stream arrives on its own raw Kafka topic
  (`raw.oem-a.v1`, `raw.oem-b.v1`) in that OEM's own format. The normaliser's adapters turn them into one canonical
  Avro event (ADR 0003).
- **No MQTT broker, no device registry, no on-vehicle code.** MQTT solves device-to-cloud links (flaky mobile
  networks, tiny payloads, per-device sessions), and here those links belong to the OEMs. Between clouds, a
  partitioned, replayable log (Kafka API) gives ordering per VIN, back-pressure and replay, which MQTT does not.
- **The OEM cloud is "the device" for security:** in production each feed would authenticate with mutual TLS
  (per-OEM client certificates), plus topic ACLs so an OEM can only write its own raw topic (threat model).
- The simulator plays both OEM clouds, including their mess: duplicates, late and out-of-order data, format
  switches, bursts.

**Consequences.**
- Onboarding a new OEM is one adapter plus one topic, not a hardware rollout.
- The data is only as fresh and rich as the OEM feed. There is no raw CAN bus and no sampling rate we choose.
  Hence the robust, hourly-scale detection (own normal, trend, k of n) rather than millisecond signals.
- Replay is free: the normaliser and state processor can be re-run from a topic offset.
