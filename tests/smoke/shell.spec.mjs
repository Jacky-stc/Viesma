import { expect, test } from '@playwright/test'
import process from 'node:process'

test('renders and advances the production playground without runtime errors', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/')
  const hud = page.getByLabel('Beginner 狀態')
  await expect(hud).toContainText('互動操作 · 待機')
  await expect(hud.getByText('HP 50 / 50', { exact: true })).toBeVisible()
  await expect(hud.getByText('MP 30 / 30', { exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: '開發用傷害測試' })).toHaveCount(0)
  await hud.evaluate((element) => {
    const states = new Set()
    globalThis.playgroundStates = states
    new globalThis.MutationObserver(() => states.add([...element.children].map((child) => child.textContent).join(' | '))).observe(
      element,
      {
        childList: true,
        characterData: true,
        subtree: true,
      }
    )
  })
  await page.getByRole('combobox', { name: '場景模式' }).selectOption('scripted')
  await expect(page.getByRole('heading', { name: 'Viesma', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Beginner 平台場景' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => [...globalThis.playgroundStates]), { timeout: 18_000 })
    .toEqual(
      expect.arrayContaining([
        '腳本播放 · 攻擊 · 朝左 | HP 50 / 50 | MP 30 / 30',
        expect.stringContaining('受擊 · 朝左 | HP 40 / 50'),
        '腳本播放 · 倒地 · 朝左 | HP 0 / 50 | MP 30 / 30',
      ])
    )
  await expect(hud.getByText('安全區生成點')).toBeVisible()
  await expect(hud.getByText('HP 50 / 50', { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Beginner 平台場景' })).toHaveCount(1)
  expect(errors).toEqual([])
})

test('resizes the same canvas and caps the backing resolution', async ({ page, context }) => {
  await page.goto('/')
  const canvas = page.getByRole('img', { name: 'Beginner 平台場景' })
  const initialCanvas = await canvas.elementHandle()
  const size = () =>
    canvas.evaluate((element) => ({
      css: element.clientWidth,
      backing: element.width,
      canvasFits: element.getBoundingClientRect().bottom <= globalThis.innerHeight,
    }))
  const initial = await size()
  const session = await context.newCDPSession(page)
  await session.send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 3, mobile: false })
  await expect
    .poll(async () => {
      const { css, backing, canvasFits } = await size()
      return css < initial.css && backing === css * 2 && canvasFits
    })
    .toBe(true)
  await session.send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 1, mobile: false })
  await expect
    .poll(async () => {
      const { css, backing } = await size()
      return css < initial.css && backing === css
    })
    .toBe(true)
  expect(await initialCanvas.evaluate((element) => element.isConnected)).toBe(true)
  await expect(canvas).toHaveCount(1)
})

test('repeatedly mounts and disposes the canvas, resize observer and WebGL context', async ({ page }) => {
  await page.addInitScript(() => {
    const activeObservers = new Set()
    globalThis.sceneObservers = { active: 0, peak: 0 }
    globalThis.ResizeObserver = class extends globalThis.ResizeObserver {
      observe(target, options) {
        super.observe(target, options)
        if (target.classList.contains('playground-canvas')) {
          activeObservers.add(this)
          globalThis.sceneObservers.active = activeObservers.size
          globalThis.sceneObservers.peak = Math.max(globalThis.sceneObservers.peak, activeObservers.size)
        }
      }

      disconnect() {
        super.disconnect()
        activeObservers.delete(this)
        globalThis.sceneObservers.active = activeObservers.size
      }
    }
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  const canvas = page.getByRole('img', { name: 'Beginner 平台場景' })
  for (let cycle = 0; cycle < 3; cycle++) {
    await expect(canvas).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => globalThis.sceneObservers.active)).toBe(1)
    const oldCanvas = await canvas.elementHandle()
    await page.getByRole('button', { name: '卸載場景' }).click()
    await expect(canvas).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => globalThis.sceneObservers.active)).toBe(0)
    await expect
      .poll(() =>
        oldCanvas.evaluate((element) => {
          const gl = element.getContext('webgl2') ?? element.getContext('webgl')
          return gl?.isContextLost()
        })
      )
      .toBe(true)
    await oldCanvas.dispose()
    await page.getByRole('button', { name: '載入場景' }).click()
  }
  await expect(canvas).toHaveCount(1)
  expect(await page.evaluate(() => globalThis.sceneObservers)).toEqual({ active: 1, peak: 1 })
  expect(errors).toEqual([])
})

test('shows a clear status when WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const { HTMLCanvasElement } = globalThis
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (contextType, ...options) {
      if (contextType === 'webgl2' || contextType === 'webgl' || contextType === 'experimental-webgl') return null
      return getContext.call(this, contextType, ...options)
    }
  })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('請確認瀏覽器支援 WebGL')
  await expect(page.locator('canvas')).toHaveCount(0)
})

test('production server responds to its health endpoint', async ({ request }) => {
  const port = Number(process.env.VIESMA_SERVER_PORT ?? 2567)
  const response = await request.get(`http://127.0.0.1:${port}/__healthcheck`, { maxRedirects: 0 })
  expect(response.status()).toBe(200)
})
