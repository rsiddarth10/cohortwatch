import { expect, type Page } from '@playwright/test';

/** Signs in through the real OIDC flow (code + PKCE) on the local issuer. */
export async function signIn(page: Page, user: string, password = `${user}-demo`): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.role')).toHaveText(user.replace(/\d+$/, ''));
}
