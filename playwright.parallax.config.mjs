import { defineConfig } from '@playwright/test'
import process from 'node:process'

const port = Number(process.env.VIESMA_PARALLAX_PORT ?? 4175)
const baseURL = `http://127.0.0.1:${port}`
const hardware = process.env.VIESMA_PARALLAX_HARDWARE === '1'

export default defineConfig({
  testDir: './tests/visual',
  outputDir: './node_modules/.cache/playwright-parallax',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL,
    browserName: 'chromium',
    ...(hardware && { channel: 'chromium' }),
    launchOptions: {
      args: hardware
        ? ['--enable-gpu', '--use-angle=d3d11', '--disable-software-rasterizer']
        : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    },
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: `pnpm --filter @viesma/client run dev:serve --port ${port} --strictPort`,
    url: `${baseURL}/parallax.html`,
  },
})
