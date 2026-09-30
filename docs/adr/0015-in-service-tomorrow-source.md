# ADR 0015: "In service tomorrow" comes from the registry flags

- **Status:** accepted (S4, 2026-09-30)
- **Context:** the queue should prefer a van that is needed tomorrow: a breakdown then costs a shift. The registry
  has `vehicle.in_service` and `vehicle.status`, and duty types have typical active hours, but there is **no shift
  calendar**.

**Decision.** A van is "in service tomorrow" when `in_service AND status = 'ACTIVE'`. In the simulated fleet that is
every van, so the 0.10 weight shifts every item equally today and changes no order. The term stays in the score and
in the reasons ("in service tomorrow") so a real rota can feed it later without a code change.

**Consequences.** It is honest about the data we have. When a fleet exports its rota (driver_assignment or a depot
calendar), only the registry loader changes.
