# Diagrams

Mermaid sources (`*.mmd`) are the truth. The SVG and PNG are rendered with `node docs/diagrams/render.mjs` (Mermaid 11.4.1
in Playwright's Chromium).

| Diagram | What it shows |
|---|---|
| [C4 level 1: context](c4-context.png) ([svg](c4-context.svg)) | CohortWatch, the OEM clouds, the three roles, the identity provider |
| [C4 level 2: containers](c4-container.png) ([svg](c4-container.svg)) | Every service, topic and store, with the protocol on every arrow (the architecture diagram) |
| [Data flow of one reading](data-flow.png) ([svg](data-flow.svg)) | raw → canonical → incident → campaign → queue → UI, including the DLQ and duplicate exits |
| [Sequence: happy path](seq-happy.png) ([svg](seq-happy.svg)) | One reading to the board, with outbox relays and the SSE "changed" notice |
| [Sequence: failure path](seq-failure.png) ([svg](seq-failure.svg)) | A duplicate and a late reading, then a state-processor SIGKILL, rebalance and replay without duplicate effects |
| [ER: core schema](er-core.png) ([svg](er-core.svg)) | The main tables and keys (the join-once PK, queue items, proposals, audit) |
| [Deployment: Kubernetes on AWS](deploy-k8s.png) ([svg](deploy-k8s.svg)) | The Helm chart on EKS, MSK, ElastiCache, S3, self-managed TimescaleDB, Secrets Manager, NetworkPolicies, TLS |
