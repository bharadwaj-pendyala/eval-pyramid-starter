import { expect, test } from '@playwright/test';

test('renders a responsive eval report', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Eval Pyramid Report');
  await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible();
  await expect(page.getByTestId('summary-cards')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(
    page.getByRole('row', { name: /^eligible-refund 1 pass/ })
  ).toBeVisible();
  await expect(
    page.getByRole('row', { name: /^ineligible-refund 1 pass/ })
  ).toBeVisible();
  await expect(
    page.getByRole('row', { name: /^missing-order-details 1 pass/ })
  ).toBeVisible();
  await expect(page.locator('.fail')).toHaveCount(0);

  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );
  expect(overflows).toBe(false);
});
