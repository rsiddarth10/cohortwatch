import type pg from 'pg';

/**
 * Shared helpers for the EVALUATION tools (S3/S5/S4+S6 scorecards and S9 `eval:all`). They run as cw_sim and join
 * the detectors' output with sim.ground_truth: evaluation only, never detection.
 */
export const H = 3_600_000;

export type Check = [check: string, expected: string, result: string];

export interface EvalContext {
  client: pg.Client;
  t0: number;
  scale: number;
}

export async function rowsOf<T extends pg.QueryResultRow>(
  c: pg.Client,
  sql: string,
  args: unknown[] = [],
): Promise<T[]> {
  return (await c.query<T>(sql, args)).rows;
}

/** "T0+12.3 h" for an event-time timestamp. */
export const sinceT0 = (t0: number, d: Date | null | undefined): string =>
  d ? `T0+${((d.getTime() - t0) / H).toFixed(1)} h` : '–';

/** Produced horizon: the end of the newest hourly telemetry row (how far the run actually got). */
export async function horizonH(c: pg.Client, t0: number): Promise<number | null> {
  const [r] = await rowsOf<{ ts: Date | null }>(c, "SELECT max(ts) + interval '1 hour' AS ts FROM core.telemetry");
  return r?.ts ? (r.ts.getTime() - t0) / H : null;
}

/** A padded Markdown table for the terminal. */
export function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(w[i]!)).join(' | ')} |`;
  return [fmt(head), `|${w.map((x) => '-'.repeat(x + 2)).join('|')}|`, ...rows.map(fmt)].join('\n');
}
