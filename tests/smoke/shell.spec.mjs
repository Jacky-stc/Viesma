import { expect, test } from '@playwright/test'

test('renders the production client shell', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Viesma', exact: true })).toBeVisible()
})

test('production server responds to its health endpoint', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:2567/__healthcheck', { maxRedirects: 0 })
  expect(response.status()).toBe(200)
})
