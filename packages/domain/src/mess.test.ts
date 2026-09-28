import { describe, expect, it } from 'vitest';
import { AUREX_V1, AUREX_V2 } from './formats/index.js';
import { DEFAULT_MESS, messUp, offlineWindow, skewMs, type MessContext, type OutMessage } from './mess.js';
import { DEFAULT_PARAMS } from './params.js';
import { generateRegistry } from './registry.js';
import { FleetStream, makeWorldContext, type SimEvent } from './simulate.js';
import { HOUR_MS, MINUTE_MS } from './time.js';
import { isValidVin } from './vin.js';

const T0 = Date.parse('2026-09-28T04:00:00Z');
const reg = generateRegistry('mess-test', 2000, T0, DEFAULT_PARAMS);
const ctx: MessContext = {
  seed: reg.seed,
  epochMs: reg.epochMs,
  cfg: DEFAULT_MESS,
  enabled: true,
  aurexV2FromMs: T0 + 12 * HOUR_MS,
};
// ~250K clean events: enough to measure small rates
const events: SimEvent[] = new FleetStream(reg.vehicles, makeWorldContext(reg, DEFAULT_PARAMS), T0).drainUntil(
  T0 + 4 * 24 * HOUR_MS,
);
const out: OutMessage[] = events.flatMap((e) => messUp(e, ctx));
const originals = out.filter((m) => !m.kinds.includes('duplicate'));
const eventByKey = new Map(events.map((e) => [`${e.vin}:${e.seq}`, e]));
const eventOf = (m: OutMessage) => eventByKey.get(`${m.vin}:${m.seq}`)!;
const rate = (k: string, base = originals) => base.filter((m) => m.kinds.includes(k as never)).length / base.length;

describe('mess injection (brief §5.5, amended)', () => {
  it('has enough events to measure', () => {
    expect(events.length).toBeGreaterThan(100_000);
    expect(originals).toHaveLength(events.length);
  });

  it.each([
    ['duplicate', DEFAULT_MESS.duplicateRate],
    ['out_of_order', DEFAULT_MESS.outOfOrderRate],
    ['malformed', DEFAULT_MESS.malformedRate],
    ['invalid_vin', DEFAULT_MESS.invalidVinRate],
    ['unknown_dtc', DEFAULT_MESS.unknownDtcRate],
    ['impossible', DEFAULT_MESS.impossibleRate],
  ])('%s at its configured rate (±30%%)', (kind, expected) => {
    const r = kind === 'duplicate' ? (out.length - originals.length) / originals.length : rate(kind);
    expect(r).toBeGreaterThan(expected * 0.7);
    expect(r).toBeLessThan(expected * 1.3);
  });

  it('skews ~0.5% of vans by ±90 s and takes ~1% of vans offline per day', () => {
    const skewed = reg.vehicles.filter((v) => skewMs(ctx, v.vin) !== 0);
    expect(skewed.length / reg.n).toBeGreaterThan(0.001);
    expect(skewed.length / reg.n).toBeLessThan(0.012);
    for (const v of skewed) expect(Math.abs(skewMs(ctx, v.vin))).toBe(90_000);
    let offline = 0;
    for (const v of reg.vehicles) for (let d = 0; d < 20; d++) if (offlineWindow(ctx, v.vin, d)) offline++;
    expect(offline / (reg.n * 20)).toBeGreaterThan(0.007);
    expect(offline / (reg.n * 20)).toBeLessThan(0.013);
  });

  it('delays out-of-order messages by 1-60 sim-minutes and flushes offline backlogs at window end', () => {
    for (const m of originals.filter((x) => x.kinds.includes('out_of_order') && !x.kinds.includes('offline'))) {
      const e = eventOf(m);
      const delay = m.releaseMs - e.eventTs;
      expect(delay).toBeGreaterThanOrEqual(MINUTE_MS);
      expect(delay).toBeLessThanOrEqual(60 * MINUTE_MS);
    }
    const off = originals.filter((m) => m.kinds.includes('offline'));
    expect(off.length).toBeGreaterThan(0);
    for (const m of off.slice(0, 50)) {
      const e = eventOf(m);
      expect(m.releaseMs).toBeGreaterThan(e.eventTs);
    }
  });

  it('corrupts invalid VINs, breaks malformed JSON, and adds unparseable DTCs', () => {
    for (const m of originals.filter((x) => x.kinds.includes('invalid_vin'))) expect(isValidVin(m.key)).toBe(false);
    let broken = 0;
    for (const m of originals.filter((x) => x.kinds.includes('malformed'))) {
      try {
        const body = JSON.parse(m.value);
        const required =
          m.format === 'kestrel.v1'
            ? ['id', 'ts', 'sq']
            : m.format === 'aurex.v2'
              ? ['vehicle', 'time', 'seqNo']
              : ['vehicle', 't', 'n'];
        const hasAll = required.every((k) => k in body);
        if (!hasAll) broken++;
      } catch {
        broken++;
      }
    }
    expect(broken).toBe(originals.filter((x) => x.kinds.includes('malformed')).length);
    const dtcRe = /^[PCBU][0-3][0-9A-F]{3}$/;
    for (const m of originals.filter((x) => x.kinds.includes('unknown_dtc') && !x.kinds.includes('malformed'))) {
      const body = JSON.parse(m.value);
      const codes: string[] = body.codes ?? String(body.dtc).split('|');
      expect(codes.some((c) => !dtcRe.test(c))).toBe(true);
    }
  });

  it('switches OEM-A from v1 (°F) to v2 (°C) at T0+12h; Kestrel is unaffected', () => {
    const aurex = originals.filter((m) => m.topic === 'raw.oem-a.v1');
    const byTs = (m: OutMessage) => eventOf(m).eventTs;
    for (const m of aurex.slice(0, 3000)) {
      expect(m.format).toBe(byTs(m) >= T0 + 12 * HOUR_MS ? AUREX_V2 : AUREX_V1);
    }
    const v2 = aurex.find((m) => m.format === AUREX_V2 && !m.kinds.includes('malformed'))!;
    const body = JSON.parse(v2.value);
    expect(body).toHaveProperty('engine.coolant');
    expect(body).toHaveProperty('seqNo');
    expect(body).not.toHaveProperty('eng');
    expect(originals.filter((m) => m.topic === 'raw.oem-b.v1').every((m) => m.format === 'kestrel.v1')).toBe(true);
  });

  it('is deterministic by (vin, seq): same content in any arrival order', () => {
    const again = events.slice(0, 5000).flatMap((e) => messUp(e, ctx));
    expect(again).toEqual(out.slice(0, again.length));
    const shuffled = [...events.slice(0, 5000)].reverse().flatMap((e) => messUp(e, ctx));
    const key = (m: OutMessage) => `${m.vin}:${m.seq}:${m.kinds.join(',')}`;
    const sort = (xs: OutMessage[]) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : 1));
    expect(sort(shuffled)).toEqual(sort(again));
  });

  it('passes events through untouched when disabled', () => {
    const off = messUp(events[0]!, { ...ctx, enabled: false });
    expect(off).toHaveLength(1);
    expect(off[0]!.kinds).toEqual([]);
    expect(off[0]!.releaseMs).toBe(events[0]!.eventTs);
  });
});
