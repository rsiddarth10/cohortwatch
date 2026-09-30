// Signs in through the real OIDC flow (code + PKCE) on the local issuer and returns an access token (a JWT for the
// API). Shared by the perf and load scripts: tokens come from the same flow the browser uses.
import { createHash, randomBytes } from 'node:crypto';

const ISS = process.env.OIDC_ISSUER ?? 'http://localhost:3200';
const REDIRECT = 'http://localhost:3000/callback';

export async function token(user = 'lead', pw = 'lead-demo') {
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
