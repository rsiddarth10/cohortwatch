-- S4: behaviour per van-hour for the queue's capped behaviour weight (harsh events per driven hour vs the duty's
-- median). Harsh counts come from Kestrel only (Aurex does not report them: NULL = unknown, never 0). No driver data.
ALTER TABLE core.telemetry ADD COLUMN harsh_count smallint, ADD COLUMN idle_s real;
