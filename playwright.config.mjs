import { defineConfig } from '@playwright/test'

const clientUrl = 'http://127.0.0.1:4173'
const healthUrl = 'http://127.0.0.1:2567/__healthcheck'

export default defineConfig({
  testDir: './tests/smoke',
  outputDir: './node_modules/.cache/playwright',
  use: { browserName: 'chromium', baseURL: clientUrl },
  webServer: [
    { command: 'pnpm --filter @viesma/client run preview', url: clientUrl },
    { command: 'pnpm --filter @viesma/server run start', url: healthUrl },
  ],
})
