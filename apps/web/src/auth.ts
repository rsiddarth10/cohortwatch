import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

/** OIDC code + PKCE against the local issuer (ADR 0018). The access token is a JWT for the API audience. */
export const ISSUER = import.meta.env.VITE_OIDC_ISSUER ?? 'http://localhost:3200';

export const userManager = new UserManager({
  authority: ISSUER,
  client_id: 'cohortwatch-web',
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: window.location.origin,
  response_type: 'code',
  scope: 'openid profile api',
  extraQueryParams: { resource: 'urn:cohortwatch:api' },
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: false,
});

export async function accessToken(): Promise<string | null> {
  const u = await userManager.getUser();
  return u && !u.expired ? u.access_token : null;
}

// prompt=login: switching users always shows the login form (the issuer keeps its own session).
export const login = () => userManager.signinRedirect({ prompt: 'login' });
export const logout = async () => {
  await userManager.removeUser();
  window.location.assign('/');
};
