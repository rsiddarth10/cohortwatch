import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * OIDC access-token validation (standard JWT: issuer, audience, expiry, RS256 against the issuer's JWKS).
 * The `role` claim maps to lead / planner / viewer; `tenant_id` scopes every query (RLS).
 */
export type Role = 'lead' | 'planner' | 'viewer';

export interface User {
  sub: string;
  name: string;
  role: Role;
  tenantId: number;
}

export type Verifier = (token: string) => Promise<User>;

export function jwtVerifier(keys: JWTVerifyGetKey, issuer: string, audience: string): Verifier {
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'] });
    const role = payload.role;
    const tenant = Number(payload.tenant_id);
    if ((role !== 'lead' && role !== 'planner' && role !== 'viewer') || !Number.isInteger(tenant)) {
      throw new Error('token has no valid role/tenant');
    }
    return { sub: String(payload.sub), name: String(payload.name ?? payload.sub), role, tenantId: tenant };
  };
}

export const remoteVerifier = (jwksUrl: string, issuer: string, audience: string): Verifier =>
  jwtVerifier(createRemoteJWKSet(new URL(jwksUrl)), issuer, audience);

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

/** Bearer token (or `access_token` query parameter for SSE, where browsers cannot set headers). */
export function authenticate(verify: Verifier) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ')
      ? h.slice(7)
      : req.path === '/events'
        ? String(req.query.access_token ?? '')
        : '';
    if (!token) {
      res.status(401).json({ error: 'missing bearer token' });
      return;
    }
    try {
      req.user = await verify(token);
      next();
    } catch {
      res.status(401).json({ error: 'invalid or expired token' });
    }
  };
}

/** The UI hides what a role cannot do; the API enforces it here. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: `requires role ${roles.join(' or ')}` });
      return;
    }
    next();
  };
