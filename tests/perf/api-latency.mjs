// API latency (p50/p95) for the board's hot endpoints, against the running compose stack.
// Signs in through the real OIDC flow (code + PKCE) as the lead, then calls each endpoint N times with C in flight.
// Usage: node tests/perf/api-latency.mjs [N=300] [C=8]   (N ≤ 600: the per-user rate limit per minute)
import { createHash, randomBytes } from 'node:crypto';

const ISS = process.env.OIDC_ISSUER ?? 'http://localhost:3200';
const API = process.env.API_URL ?? 'http://localhost:3100';
const REDIRECT = 'http://localhost:3000/callback';
const [N = 300, C = 8] = process.argv.slice(2).map(Number);

async function token(user = 'lead', pw = 'lead-demo') {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const jar = new Map();
  const go = async (url, init = {}) => {
    const r = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers ?? {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return r;
  };
  let url = `${ISS}/auth?client_id=cohortwatch-web&response_type=code&scope=openid%20profile%20api&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=s&resource=urn%3Acohortwatch%3Aapi`;
  for (let i = 0; i < 10 && !url.startsWith(REDIRECT); i++) {
    const r = await go(url);
    if (r.status === 200 && url.includes('/interaction/')) {
      const uid = url.split('/interaction/')[1];
      const p = await go(`${ISS}/interaction/${uid}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `username=${user}&password=${pw}`,
      });
      url = new URL(p.headers.get('location'), ISS).toString();
      continue;
    }
    url = new URL(r.headers.get('location'), ISS).toString();
  }
  const code = new URL(url).searchParams.get('code');
  const t = await fetch(`${ISS}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: 'cohortwatch-web',
      code_verifier: verifier,
    }),
  });
  return (await t.json()).access_token;
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function bench(name, path, auth) {
  const times = [];
  let next = 0;
  let errors = 0;
  const worker = async () => {
    while (next < N) {
      next++;
      const t0 = performance.now();
      const r = await fetch(`${API}${path}`, { headers: { authorization: auth } });
      await r.arrayBuffer();
      if (!r.ok) errors++;
      times.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: C }, worker));
  times.sort((a, b) => a - b);
  return {
    name,
    n: times.length,
    errors,
    p50: pct(times, 50).toFixed(1),
    p95: pct(times, 95).toFixed(1),
    max: times.at(-1).toFixed(1),
  };
}

// one demo user per endpoint: the API rate limit (600/min) is per user
const auth = `Bearer ${await token()}`;
const planner = `Bearer ${await token('planner', 'planner-demo')}`;
const viewer = `Bearer ${await token('viewer', 'viewer-demo')}`;
const get = async (p) => (await fetch(`${API}${p}`, { headers: { authorization: auth } })).json();
const depots = (await get('/depots')).items;
const campaigns = (await get('/campaigns?status=OPEN&limit=5')).items;
const depot = depots[0].id;
const rows = [
  await bench(`GET /depots/${depot}/queue`, `/depots/${depot}/queue`, auth),
  await bench('GET /campaigns?status=OPEN', '/campaigns?status=OPEN&limit=25', planner),
];
if (campaigns[0]) rows.push(await bench('GET /campaigns/:id', `/campaigns/${campaigns[0].id}`, viewer));
console.log(`N=${N} per endpoint, ${C} in flight, depots=${depots.length}, open campaigns=${campaigns.length}`);
console.log('| endpoint | n | errors | p50 ms | p95 ms | max ms |\n|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.n} | ${r.errors} | ${r.p50} | ${r.p95} | ${r.max} |`);
