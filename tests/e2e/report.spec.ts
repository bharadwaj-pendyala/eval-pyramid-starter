import { expect, test } from '@playwright/test';

test('renders a responsive eval report', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Eval Pyramid Report');
  await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible();
  await expect(page.getByTestId('summary-cards')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Provenance' })).toBeVisible();
  await expect(page.getByText(/scored, \d+ invalid/u)).toBeVisible();

  const overflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );
  expect(overflows).toBe(false);
});
