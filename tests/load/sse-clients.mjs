// N concurrent SSE clients on /events for S seconds (S9 load test; k6 has no built-in SSE).
// Reports: connected, dropped, events received, first-event latency, reconnects.
// Usage: node tests/load/sse-clients.mjs [N=50] [S=600]   (env API_URL, default http://localhost:3100)
import { token } from '../perf/oidc.mjs';

const API = process.env.API_URL ?? 'http://localhost:3100';
const [N = 50, S = 600] = process.argv.slice(2).map(Number);
const tok = await token('viewer', 'viewer-demo'); // viewers get the same stream, tenant-filtered
const stats = { connected: 0, failed: 0, dropped: 0, events: 0, pings: 0, firstEventMs: [] };
const deadline = Date.now() + S * 1000;

async function client(i) {
  const started = Date.now();
  let first = true;
  while (Date.now() < deadline) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), deadline - Date.now());
      const r = await fetch(`${API}/events?access_token=${encodeURIComponent(tok)}`, { signal: ac.signal });
      if (!r.ok) {
        stats.failed++;
        clearTimeout(timer);
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      stats.connected++;
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        const text = dec.decode(chunk);
        const ev = (text.match(/^event: /gm) ?? []).length;
        stats.events += ev;
        stats.pings += (text.match(/^: ping/gm) ?? []).length;
        if (ev && first) {
          stats.firstEventMs.push(Date.now() - started);
          first = false;
        }
      }
      clearTimeout(timer);
      if (Date.now() < deadline) stats.dropped++; // the server closed the stream early
    } catch (err) {
      if (Date.now() < deadline && err.name !== 'AbortError') stats.dropped++;
    }
  }
  void i;
}

const t0 = Date.now();
const progress = setInterval(() => console.log(`${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify({ ...stats, firstEventMs: stats.firstEventMs.length })}`), 60_000); // prettier-ignore
await Promise.all(Array.from({ length: N }, (_, i) => client(i)));
clearInterval(progress);
const fe = [...stats.firstEventMs].sort((a, b) => a - b);
console.log(
  JSON.stringify({
    clients: N,
    seconds: S,
    connected: stats.connected,
    failed: stats.failed,
    dropped: stats.dropped,
    events: stats.events,
    events_per_client: +(stats.events / N).toFixed(1),
    pings: stats.pings,
    first_event_ms_p50: fe[fe.length >> 1] ?? null,
  }),
);
