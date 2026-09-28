import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import type { RandomGenerator } from 'pure-rand/types/RandomGenerator';

/**
 * 32-bit FNV-1a over the joined parts. Used to derive independent seeds such as
 * hash(global_seed, VIN, day), so a vehicle's stream never depends on which worker runs it.
 */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join('\u0001');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // final avalanche (murmur3 fmix32) so close inputs give unrelated seeds
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Small seeded RNG facade over pure-rand's xoroshiro128+. */
export class Rng {
  private readonly g: RandomGenerator;
  private spare: number | null = null;

  constructor(seed: number) {
    this.g = xoroshiro128plus(seed | 0);
  }

  static of(...parts: (string | number)[]): Rng {
    return new Rng(hashSeed(...parts));
  }

  /** Uniform float in [0, 1) with 53 bits of precision. */
  next(): number {
    const a = this.g.next() >>> 5;
    const b = this.g.next() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Normal via Box-Muller (caches the second value). */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const z = this.spare;
      this.spare = null;
      return mean + sd * z;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return mean + sd * r * Math.cos(2 * Math.PI * v);
  }

  /** Poisson (Knuth; fine for the small rates used here). */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Pick by weight; weights need not sum to 1. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let x = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      x -= weights[i]!;
      if (x < 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}
