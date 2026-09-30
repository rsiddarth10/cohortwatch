/* global __ENV */
// k6 load + soak test of the API's hot read endpoints (S9, docs/perf/load.md).
// Run in the pinned k6 image on the compose network (see tests/load/run.sh):
//   k6 run -e TOKEN=<lead JWT> -e API=http://api:3100 -e PROFILE=load|soak tests/load/api.js
// Each request is a full production request: JWT check → one transaction as cw_api with the tenant set (RLS)
// → queries → an audit row + outbox row → JSON.
import http from 'k6/http';
import { check } from 'k6';

const API = __ENV.API || 'http://api:3100';
const PROFILE = __ENV.PROFILE || 'load';
const params = { headers: { authorization: `Bearer ${__ENV.TOKEN}` }, timeout: '30s' };

const PROFILES = {
  smoke: { executor: 'constant-vus', vus: 5, duration: '15s' },
  // ramp to 50 concurrent users over 3 minutes: where does latency bend?
  load: {
    executor: 'ramping-vus',
    startVUs: 1,
    stages: [
      { duration: '30s', target: 10 },
      { duration: '60s', target: 25 },
      { duration: '60s', target: 50 },
      { duration: '30s', target: 0 },
    ],
  },
  // steady 20 users for 10 minutes: does anything leak or drift?
  soak: { executor: 'constant-vus', vus: 20, duration: '10m' },
};

export const options = {
  scenarios: { api: PROFILES[PROFILE] },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:queue}': ['p(95)<1500'],
    'http_req_duration{endpoint:campaigns}': ['p(95)<1500'],
    'http_req_duration{endpoint:campaign}': ['p(95)<1500'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const depots = http
    .get(`${API}/depots`, params)
    .json('items')
    .map((d) => d.id);
  const campaigns = http
    .get(`${API}/campaigns?status=OPEN&limit=25`, params)
    .json('items')
    .map((c) => c.id);
  return { depots: depots.slice(0, 30), campaigns };
}

export default function (data) {
  const r = Math.random();
  let res;
  if (r < 0.5) {
    const d = data.depots[Math.floor(Math.random() * data.depots.length)];
    res = http.get(`${API}/depots/${d}/queue`, { ...params, tags: { endpoint: 'queue' } });
  } else if (r < 0.75 || data.campaigns.length === 0) {
    res = http.get(`${API}/campaigns?status=OPEN&limit=25`, { ...params, tags: { endpoint: 'campaigns' } });
  } else {
    const c = data.campaigns[Math.floor(Math.random() * data.campaigns.length)];
    res = http.get(`${API}/campaigns/${c}`, { ...params, tags: { endpoint: 'campaign' } });
  }
  check(res, { 'status 200': (x) => x.status === 200 });
}
