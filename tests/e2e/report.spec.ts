import { expect, test } from '@playwright/test';

test('renders a responsive eval report', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Eval Pyramid Report');
  await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible();
  await expect(page.getByTestId('summary-cards')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Release gate checks' })
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Provenance' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(2);
  await expect(
    page.getByRole('row', { name: /^eligible-refund critical 1 pass/ })
  ).toBeVisible();
  await expect(
    page.getByRole('row', { name: /^ineligible-refund critical 1 pass/ })
  ).toBeVisible();
  await expect(
    page.getByRole('row', { name: /^missing-order-details high 1 pass/ })
  ).toBeVisible();
  await expect(page.locator('.fail')).toHaveCount(0);

  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );
  expect(overflows).toBe(false);
});
