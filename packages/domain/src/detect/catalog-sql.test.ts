import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAULT_CODES } from '../catalog.js';
import { FAMILIES, METRIC_FAMILY } from './params.js';

const sql = readFileSync(
  fileURLToPath(new URL('../../../../infra/db/migrations/005_detection.sql', import.meta.url)),
  'utf8',
);

describe('migration 005 seeds the same fault-code table as the domain catalog', () => {
  it('codes → family', () => {
    const seeded = [...sql.matchAll(/\('([PCBU][0-3][0-9A-F]{3})', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}:${m[2]}`);
    const domain = Object.entries(FAULT_CODES).flatMap(([fam, codes]) => codes.map((c) => `${c}:${fam}`));
    expect(seeded.sort()).toEqual(domain.sort());
  });
  it('families and their metrics', () => {
    for (const f of FAMILIES) expect(sql).toContain(`('${f}', `);
    for (const [metric, fam] of Object.entries(METRIC_FAMILY))
      expect(sql).toMatch(new RegExp(`\\('${fam}', '[^']+', '${metric}'\\)`));
  });
});
