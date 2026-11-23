import { defineConfig } from '@playwright/test'
import process from 'node:process'

const clientUrl = 'http://127.0.0.1:4173'
const healthUrl = `http://127.0.0.1:${Number(process.env.VIESMA_SERVER_PORT ?? 2567)}/__healthcheck`

export default defineConfig({
  testDir: './tests/smoke',
  outputDir: './node_modules/.cache/playwright',
  use: {
    browserName: 'chromium',
    baseURL: clientUrl,
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: [
    { command: 'pnpm --filter @viesma/client run preview', url: clientUrl },
    { command: 'pnpm --filter @viesma/server run start', url: healthUrl },
  ],
})
