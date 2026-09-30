-- S5: each hourly telemetry row also carries the van's last peer-adjusted score per metric (deviation from its own
-- normal minus its peers', in the bad direction; robust z of level and slope). The campaign engine reads them for
-- at-risk sisters (vans WITHOUT an incident); S4 reuses them for solo at-risk vans (ADR 0011).
ALTER TABLE core.telemetry
  ADD COLUMN coolant_dev real, ADD COLUMN coolant_z real, ADD COLUMN coolant_zs real,
  ADD COLUMN batt_dev real, ADD COLUMN batt_z real, ADD COLUMN batt_zs real,
  ADD COLUMN lv_dev real, ADD COLUMN lv_z real, ADD COLUMN lv_zs real;
