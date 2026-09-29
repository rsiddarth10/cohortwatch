import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { GlobalHit } from '@cw/domain';
import type pg from 'pg';
import type { IncidentOut } from './processor.js';

/**
 * Incident output: Postgres (core.incident + core.incident_clue, one transaction per batch) then Kafka
 * (incidents.v1, key = family key). Both are idempotent: the id is uuid5(vin, family, window), the row is an
 * upsert, and a replayed OPEN never downgrades an escalated incident. Awaited before the batch's offsets move.
 */

const UPSERT = `
INSERT INTO core.incident (id, vin, fault_family, window_bucket, family_key, trigger, metric, status, severity, runaway,
  opened_ts, opened_seq, critical_ts, hours_to_limit, depot_id, model_id, duty_type_id, region_id, firmware,
  level, baseline_median, deviation, peer_adj, z_level, z_slope, slope_per_h, dtc_count_24h, baseline_source, latency_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9::boolean, $10::timestamptz, $11, CASE WHEN $9::boolean THEN $10::timestamptz END, $12, $13, $14, $15, $16, $17,
  $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
ON CONFLICT (id) DO UPDATE SET
  status = 'OPEN',
  closed_ts = NULL,
  trigger = CASE WHEN core.incident.trigger = 'SIGNAL' THEN 'SIGNAL' ELSE EXCLUDED.trigger END,
  metric = coalesce(EXCLUDED.metric, core.incident.metric),
  severity = CASE WHEN core.incident.severity = 'CRITICAL' OR EXCLUDED.severity = 'CRITICAL' THEN 'CRITICAL'
                  WHEN core.incident.severity = 'HIGH' OR EXCLUDED.severity = 'HIGH' THEN 'HIGH' ELSE 'WARN' END,
  runaway = core.incident.runaway OR EXCLUDED.runaway,
  critical_ts = coalesce(core.incident.critical_ts, EXCLUDED.critical_ts),
  hours_to_limit = EXCLUDED.hours_to_limit,
  level = EXCLUDED.level, deviation = EXCLUDED.deviation, peer_adj = EXCLUDED.peer_adj,
  z_level = EXCLUDED.z_level, z_slope = EXCLUDED.z_slope, slope_per_h = EXCLUDED.slope_per_h,
  dtc_count_24h = EXCLUDED.dtc_count_24h,
  updated_at = now()`;

export class IncidentSink {
  constructor(
    private readonly pool: pg.Pool,
    private readonly producer: KafkaJS.Producer,
    private readonly topic: string,
  ) {}

  /** Returns the wall-clock latency (ms, x-sent-at → written) of each OPEN, for the latency histogram. */
  async write(incidents: readonly IncidentOut[], hits: readonly GlobalHit[]): Promise<number[]> {
    if (incidents.length === 0 && hits.length === 0) return [];
    const latencies: number[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const { message: m, sentAt } of incidents) {
        if (m.action === 'CLOSE') {
          await client.query(
            `UPDATE core.incident SET status = 'CLOSED', closed_ts = $2, updated_at = now() WHERE id = $1`,
            [m.incident_id, m.event_ts],
          );
          continue;
        }
        const latency = sentAt ? Date.now() - sentAt : null;
        const n = m.numbers;
        await client.query(UPSERT, [
          m.incident_id, m.vin, m.fault_family, m.window_bucket, m.family_key, m.trigger, m.metric, m.severity,
          m.runaway, m.event_ts, m.seq, m.hours_to_limit, m.depot_id, m.model_id, m.duty_type_id, m.region_id,
          m.firmware, n.level, n.baseline_median, n.deviation, n.peer_adj, n.z_level, n.z_slope, n.slope_per_h,
          n.dtc_count_24h, m.baseline_source, latency,
        ]); // prettier-ignore
        await client.query('DELETE FROM core.incident_clue WHERE incident_id = $1', [m.incident_id]);
        if (m.clues.length > 0) {
          const params: unknown[] = [m.incident_id];
          const rows = m.clues.map((c, k) => {
            params.push(k, c.type, c.text, c.value, c.unit);
            const b = 2 + k * 5;
            return `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
          });
          await client.query(
            `INSERT INTO core.incident_clue (incident_id, ord, clue_type, text, value, unit) VALUES ${rows.join(', ')}`,
            params,
          );
        }
        if (m.action === 'OPEN' && latency !== null) latencies.push(latency);
      }
      for (const h of hits) {
        await client.query(
          'INSERT INTO core.global_rule_hit (vin, metric, first_ts) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [h.vin, h.metric, new Date(h.ts).toISOString()],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (incidents.length > 0) {
      const now = String(Date.now());
      await this.producer.send({
        topic: this.topic,
        messages: incidents.map(({ message: m, sentAt }) => ({
          key: m.family_key,
          value: JSON.stringify(m),
          headers: {
            'x-sent-at': sentAt ? String(sentAt) : '',
            'x-incident-at': now,
            'x-action': m.action,
            'x-incident-id': m.incident_id,
          },
        })),
      });
    }
    return latencies;
  }
}
