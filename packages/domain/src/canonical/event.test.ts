import { describe, expect, it } from 'vitest';
import { CanonicalEventSchema, EVENT_ID_NAMESPACE, eventId, flag, flagType, uuidV5 } from './event.js';
import { sha1 } from './sha1.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('sha1 (FIPS 180-4 test vectors)', () => {
  it.each([
    ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '84983e441c3bd26ebaae4aa1f95129e5e54670f1'],
    ['a'.repeat(1000), '291e9a6c66994949b57ba5e650361e98fc36b1ba'],
  ])('sha1(%j)', (input, digest) => {
    expect(hex(sha1(utf8(input)))).toBe(digest);
  });
});

describe('event ids', () => {
  it('uuidV5 matches the RFC reference (DNS namespace, "python.org")', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('is deterministic per (vin, seq) and differs otherwise', () => {
    const a = eventId('7KSHM1D84RK100001', 88);
    expect(eventId('7KSHM1D84RK100001', 88)).toBe(a);
    expect(eventId('7KSHM1D84RK100001', 89)).not.toBe(a);
    expect(eventId('7KSHM1D84RK100002', 88)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(EVENT_ID_NAMESPACE).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('quality flags and schema', () => {
  it('flags carry a type and an optional field', () => {
    expect(flag('OUT_OF_RANGE', 'soc_pct')).toBe('OUT_OF_RANGE:soc_pct');
    expect(flag('LATE')).toBe('LATE');
    expect(flagType('OUT_OF_RANGE:soc_pct')).toBe('OUT_OF_RANGE');
  });

  it('rejects events that break the contract', () => {
    const ok = {
      event_id: eventId('7KSHM1D84RK100001', 1),
      vin: '7KSHM1D84RK100001',
      seq: 1,
      event_ts: '2026-09-28T10:15:02.120Z',
      evt: 'PERIODIC',
      lat: 14.1,
      lon: 74.6,
      speed_kmh: 40,
      odo_km: 100,
      ambient_c: 30,
      coolant_c: 90,
      rpm: null,
      batt_temp_c: null,
      soc_pct: null,
      fuel_pct: 50,
      lv_batt_v: 14.1,
      ignition: true,
      charging: false,
      harsh_brake: 0,
      harsh_accel: 0,
      idle_s: 0,
      dtc: ['P0217'],
      fault_families: ['COOLING'],
      firmware: '4.2.1',
      source_format: 'kestrel.v1',
      quality_flags: [],
    };
    expect(CanonicalEventSchema.safeParse(ok).success).toBe(true);
    expect(CanonicalEventSchema.safeParse({ ...ok, event_ts: '2026-09-28 10:15' }).success).toBe(false);
    expect(CanonicalEventSchema.safeParse({ ...ok, evt: 'TELEPORT' }).success).toBe(false);
    expect(CanonicalEventSchema.safeParse({ ...ok, seq: -1 }).success).toBe(false);
    expect(CanonicalEventSchema.safeParse({ ...ok, fault_families: ['PLUMBING'] }).success).toBe(false);
    expect(CanonicalEventSchema.safeParse({ ...ok, coolant_c: Number.NaN }).success).toBe(false);
  });
});
