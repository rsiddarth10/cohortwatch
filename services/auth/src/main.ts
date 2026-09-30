import { pathToFileURL } from 'node:url';
import { createLogger } from '@cw/common';
import express from 'express';
import { exportJWK, generateKeyPair } from 'jose';
import Provider, { errors, type Configuration } from 'oidc-provider';

/**
 * S7 local OIDC issuer (ADR 0018) — DEV ONLY. Standard OpenID Connect via `oidc-provider`: authorization code + PKCE
 * for the web app, a JWKS endpoint, and JWT access tokens for the API (audience `urn:cohortwatch:api`) carrying the
 * user's `role` and `tenant_id`. Demo users and passwords are in the README; a real deployment points the API and
 * the web app at the organisation's IdP instead (only the issuer URL changes).
 */
const log = createLogger('auth', process.env.LOG_LEVEL ?? 'info');
const ISSUER = process.env.OIDC_ISSUER ?? 'http://localhost:3200';
const PORT = Number(process.env.PORT ?? 3200);
const AUDIENCE = process.env.API_AUDIENCE ?? 'urn:cohortwatch:api';
const REDIRECTS = (process.env.REDIRECT_URIS ?? 'http://localhost:3000/callback,http://localhost:5173/callback')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export interface DemoUser {
  password: string;
  role: 'lead' | 'planner' | 'viewer';
  tenant_id: number;
  name: string;
}

/** Dev-only demo users (README). `lead2` belongs to the second tenant: it shows row-level security. */
export const USERS: Record<string, DemoUser> = {
  lead: { password: process.env.LEAD_PASSWORD ?? 'lead-demo', role: 'lead', tenant_id: 1, name: 'Asha (reliability lead)' },
  planner: { password: process.env.PLANNER_PASSWORD ?? 'planner-demo', role: 'planner', tenant_id: 1, name: 'Ravi (workshop planner)' },
  viewer: { password: process.env.VIEWER_PASSWORD ?? 'viewer-demo', role: 'viewer', tenant_id: 1, name: 'Meera (depot manager)' },
  lead2: { password: process.env.LEAD2_PASSWORD ?? 'lead2-demo', role: 'lead', tenant_id: 2, name: 'Kiran (lead, tenant 2)' },
}; // prettier-ignore

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(uid: string, error = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CohortWatch sign-in</title><style>
body{font-family:system-ui,sans-serif;background:#f4f5f7;display:grid;place-items:center;min-height:100vh;margin:0;color:#1d2433}
form{background:#fff;padding:28px 32px;border-radius:10px;box-shadow:0 2px 12px #0002;width:300px}
h1{font-size:18px;margin:0 0 4px}p{color:#5b6475;font-size:13px;margin:0 0 16px}
label{display:block;font-size:13px;margin:10px 0 4px}input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #c9ced8;border-radius:6px;font-size:14px}
button{margin-top:16px;width:100%;padding:9px;background:#2356c4;color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer}
.err{color:#b3261e;font-size:13px;margin-top:8px}.hint{font-size:12px;color:#5b6475;margin-top:14px}</style></head>
<body><form method="post" action="/interaction/${esc(uid)}/login" autocomplete="off">
<h1>CohortWatch</h1><p>Local dev sign-in (OIDC)</p>
<label for="u">User</label><input id="u" name="username" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" required>
<button type="submit">Sign in</button>${error ? `<div class="err">${esc(error)}</div>` : ''}
<div class="hint">Demo users: lead, planner, viewer (passwords in the README).</div></form></body></html>`;
}

export async function startAuth(port = PORT): Promise<{ close(): Promise<void> }> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: 'cw-dev-1', alg: 'RS256', use: 'sig' };

  const configuration: Configuration = {
    clients: [
      {
        client_id: 'cohortwatch-web',
        token_endpoint_auth_method: 'none',
        redirect_uris: REDIRECTS,
        post_logout_redirect_uris: REDIRECTS.map((u) => u.replace(/\/callback$/, '/')),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    ],
    jwks: { keys: [jwk] },
    cookies: { keys: [process.env.COOKIE_KEY ?? 'dev-only-cookie-key-change-me'] },
    scopes: ['openid', 'profile', 'offline_access', 'api'],
    claims: { openid: ['sub'], profile: ['name', 'role', 'tenant_id'] },
    findAccount: async (_ctx, id) => {
      const u = USERS[id];
      if (!u) return undefined;
      return { accountId: id, claims: async () => ({ sub: id, name: u.name, role: u.role, tenant_id: u.tenant_id }) };
    },
    features: {
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => AUDIENCE,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== AUDIENCE) throw new errors.InvalidTarget();
          return { scope: 'api', audience: AUDIENCE, accessTokenTTL: 3600, accessTokenFormat: 'jwt', jwt: { sign: { alg: 'RS256' } } };
        },
      },
    },
    extraTokenClaims: async (_ctx, token) => {
      const u = 'accountId' in token && token.accountId ? USERS[token.accountId as string] : undefined;
      return u ? { role: u.role, tenant_id: u.tenant_id, name: u.name } : undefined;
    },
    pkce: { required: () => true },
    ttl: { AccessToken: 3600, AuthorizationCode: 120, IdToken: 3600, Interaction: 900, Session: 8 * 3600, Grant: 8 * 3600, RefreshToken: 8 * 3600 },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    clientBasedCORS: () => true,
  }; // prettier-ignore
  const provider = new Provider(ISSUER, configuration);

  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.get('/interaction/:uid', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name === 'login') {
        res.type('html').send(loginPage(details.uid));
        return;
      }
      // consent: first-party app, granted automatically (openid profile + the API resource)
      const { params, session } = details;
      const grant = details.grantId
        ? (await provider.Grant.find(details.grantId))!
        : new provider.Grant({ accountId: session!.accountId, clientId: params.client_id as string });
      const d = details.prompt.details as {
        missingOIDCScope?: string[];
        missingResourceScopes?: Record<string, string[]>;
      };
      if (d.missingOIDCScope) grant.addOIDCScope(d.missingOIDCScope.join(' '));
      for (const [resource, scopes] of Object.entries(d.missingResourceScopes ?? {}))
        grant.addResourceScope(resource, scopes.join(' '));
      const grantId = await grant.save();
      await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/interaction/:uid/login', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const { username, password } = req.body as { username?: string; password?: string };
      const u = username ? USERS[username] : undefined;
      if (!u || u.password !== password) {
        log.info({ username }, 'sign-in rejected');
        res.status(401).type('html').send(loginPage(details.uid, 'Unknown user or wrong password.'));
        return;
      }
      log.info({ username, role: u.role }, 'signed in');
      await provider.interactionFinished(
        req,
        res,
        { login: { accountId: username! } },
        { mergeWithLastSubmission: false },
      );
    } catch (err) {
      next(err);
    }
  });

  app.use(provider.callback());
  const server = app.listen(port);
  log.info({ issuer: ISSUER, port, redirects: REDIRECTS }, 'OIDC issuer running (dev only)');
  return { close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAuth().catch((err: unknown) => {
    log.fatal({ err }, 'auth failed');
    process.exit(1);
  });
}
