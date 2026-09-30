import { expect, test } from '@playwright/test';
import { signIn } from './login';

/**
 * E2E smoke (local only: needs the compose stack running with the plant on; waits for the S1 campaign):
 * the lead logs in → opens the S1 campaign → approves the agent's proposal → the board shows the booked vans live.
 * Then a viewer sees the same van without driver or precise location.
 */
test('lead: S1 campaign → approve the agent proposal → the board updates', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  await signIn(page, 'lead');

  // the S1 outbreak: wait (sim time runs 360×) for an open campaign with at-risk sisters and a pending proposal
  await expect(async () => {
    await page.goto('/agent');
    await expect(page.locator('article.proposal').filter({ hasText: 'at-risk sister' }).first()).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 18 * 60_000, intervals: [15_000] });

  const proposal = page.locator('article.proposal').filter({ hasText: 'at-risk sister' }).first();
  await proposal.getByRole('link', { name: 'campaign' }).click();
  await expect(page.locator('h1')).toContainText('campaign');
  await expect(page.getByText('Why we think it is one outbreak')).toBeVisible();
  await expect(page.locator('.clues li').first()).toBeVisible();
  const depotLink = page.locator('h1 a');
  const depotHref = await depotLink.getAttribute('href');

  await page
    .locator('.proposal')
    .filter({ hasText: 'PENDING' })
    .first()
    .getByRole('button', { name: 'Approve', exact: true })
    .click();
  await expect(page.getByText('Approved: the workshop re-plans the bays')).toBeVisible();

  await page.goto(depotHref!);
  await expect(page.locator('.qcard .why', { hasText: 'booked by lead' }).first()).toBeVisible({ timeout: 60_000 });
});

test('viewer: masked van, no approve buttons', async ({ page }) => {
  await signIn(page, 'viewer');
  await expect(page.getByText('precise locations and drivers are hidden')).toBeVisible();
  await page.locator('a.qcard, a.vin').first().click();
  await expect(page.getByText('driver hidden')).toBeVisible();
  await expect(page.getByText(/area \w{5}/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record repair' })).toHaveCount(0);
  await page.goto('/agent');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
});
