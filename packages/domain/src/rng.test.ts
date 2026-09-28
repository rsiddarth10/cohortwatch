import { describe, expect, it } from 'vitest';
import { Rng, clamp, hashSeed } from './rng.js';

describe('hashSeed / Rng', () => {
  it('is deterministic and sensitive to every part', () => {
    expect(hashSeed('s', 'VIN1', 3)).toBe(hashSeed('s', 'VIN1', 3));
    expect(hashSeed('s', 'VIN1', 3)).not.toBe(hashSeed('s', 'VIN1', 4));
    expect(hashSeed('s', 'VIN1')).not.toBe(hashSeed('s', 'VIN2'));
    // part boundaries matter: ("ab","c") != ("a","bc")
    expect(hashSeed('ab', 'c')).not.toBe(hashSeed('a', 'bc'));
  });

  it('replays the same sequence for the same seed', () => {
    const a = Rng.of('x', 1);
    const b = Rng.of('x', 1);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces sane distributions', () => {
    const r = new Rng(123);
    const n = 20_000;
    let sum = 0;
    let sumSq = 0;
    let pois = 0;
    let ints = true;
    for (let i = 0; i < n; i++) {
      const x = r.normal(10, 2);
      sum += x;
      sumSq += x * x;
      pois += r.poisson(3);
      const k = r.int(1, 6);
      if (k < 1 || k > 6 || !Number.isInteger(k)) ints = false;
      const u = r.next();
      if (u < 0 || u >= 1) ints = false;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(mean).toBeCloseTo(10, 1);
    expect(sd).toBeCloseTo(2, 1);
    expect(pois / n).toBeCloseTo(3, 1);
    expect(ints).toBe(true);
    expect(r.poisson(0)).toBe(0);
  });

  it('weighted, pick, chance and uniform behave', () => {
    const r = new Rng(7);
    let a = 0;
    for (let i = 0; i < 10_000; i++) if (r.weighted(['a', 'b'], [3, 1]) === 'a') a++;
    expect(a / 10_000).toBeGreaterThan(0.72);
    expect(a / 10_000).toBeLessThan(0.78);
    expect(['x', 'y']).toContain(r.pick(['x', 'y']));
    expect(() => r.pick([])).toThrow();
    expect(r.chance(0)).toBe(false);
    expect(r.chance(1)).toBe(true);
    const u = r.uniform(5, 6);
    expect(u).toBeGreaterThanOrEqual(5);
    expect(u).toBeLessThan(6);
    expect(r.weighted(['only'], [0])).toBe('only');
  });

  it('clamps', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
