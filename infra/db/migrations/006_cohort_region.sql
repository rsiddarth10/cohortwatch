-- S3: the cohort fallback for vans without history is per model × duty × REGION (region_id 0 = all regions).
-- A climate-blind cohort put a hot-region van several °C "above its normal" (battery temperature follows ambient).
ALTER TABLE core.cohort_baseline ADD COLUMN region_id smallint NOT NULL DEFAULT 0;
ALTER TABLE core.cohort_baseline DROP CONSTRAINT cohort_baseline_pkey;
ALTER TABLE core.cohort_baseline ADD PRIMARY KEY (model_id, duty_type_id, region_id, metric);
