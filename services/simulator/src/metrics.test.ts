import { describe, expect, it } from 'vitest';
import { SimMetrics } from './metrics.js';

describe('SimMetrics', () => {
  it('counts messages per topic and format and computes the window rate', async () => {
    const m = new SimMetrics();
    const t0 = Date.now();
    m.roll(t0);
    m.add({ 'raw.oem-a.v1|aurex.v1': 30, 'raw.oem-b.v1|kestrel.v1': 20 });
    m.add({ 'raw.oem-a.v1|aurex.v1': 20 });
    const r = m.roll(t0 + 5000);
    expect(r.total).toBe(70);
    expect(r.msgsPerSec).toBe(14);
    expect(r.byStream['raw.oem-a.v1 aurex.v1']).toBe(10);
    expect(r.byStream['raw.oem-b.v1 kestrel.v1']).toBe(4);

    const text = await m.registry.metrics();
    expect(text).toContain('cw_sim_messages_sent_total{topic="raw.oem-a.v1",format="aurex.v1"} 50');
    expect(text).toContain('cw_sim_messages_per_second_total 14');

    // next window with no traffic drops to zero
    expect(m.roll(t0 + 10_000).msgsPerSec).toBe(0);
  });
});
