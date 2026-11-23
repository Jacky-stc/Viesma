import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { URL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { installAtlasAudit, readAtlasAudit } from './atlas-audit.mjs'

const canvasName = 'Beginner 平台場景'
const atlasUrl = /\/game-assets\/(beginner|village|field)-atlas\.[a-f0-9]{16}\.png$/

test('Village lazily loads its atlases within the cold-load budget and publishes credits', async ({ page, context, browser }, testInfo) => {
  const responses = new Map()
  const errors = []
  page.on('response', (response) => responses.set(response.url(), response))
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const session = await context.newCDPSession(page)
  await session.send('Network.enable')
  await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  await installAtlasAudit(page)
  await page.goto('/')
  await expect(page.getByLabel('目前地圖')).toHaveText('Village')
  const firstScene = ['beginner', 'village']
  await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: firstScene, textures: firstScene })
  expect(
    [...responses.keys()]
      .map((url) => atlasUrl.exec(url)?.[1])
      .filter(Boolean)
      .sort()
  ).toEqual(firstScene)
  const resources = await Promise.all(
    [...responses.values()].map(async (response) => {
      const path = new URL(response.url()).pathname
      expect(response.ok(), path).toBe(true)
      const body = await response.body()
      const type = response.headers()['content-type'] ?? ''
      const compressedBytes = /^(?:text\/|(?:application|text)\/javascript)/.test(type) ? gzipSync(body).length : body.length
      return { path, bytes: body.length, compressedBytes }
    })
  )
  const compressedBytes = resources.reduce((sum, entry) => sum + entry.compressedBytes, 0)
  expect(compressedBytes).toBeLessThanOrEqual(5 * 1024 * 1024)
  const evidence = JSON.stringify({ browser: browser.version(), compressedBytes, resources }, null, 2)
  const evidencePath = testInfo.outputPath('village-cold-load.json')
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, evidence + '\n')
  await testInfo.attach('village-cold-load', { path: evidencePath, contentType: 'application/json' })
  await page.getByRole('img', { name: canvasName }).screenshot({ path: testInfo.outputPath('village-atlases.png') })

  await page.getByRole('button', { name: '操作說明' }).click()
  const href = await page.getByRole('link', { name: '素材來源與署名' }).getAttribute('href')
  const credits = await page.request.get(href)
  expect(credits.ok()).toBe(true)
  expect(await credits.text()).toContain('village-guide')
  expect(errors).toEqual([])
})

test('a missing optional atlas and an undecodable Beginner atlas leave the graybox playable', async ({ page }, testInfo) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const missing = page.waitForResponse((response) => atlasUrl.exec(response.url())?.[1] === 'village' && response.status() === 404)
  const corrupt = page.waitForResponse((response) => atlasUrl.exec(response.url())?.[1] === 'beginner')
  await page.route(atlasUrl, (route) => {
    const atlas = atlasUrl.exec(route.request().url())?.[1]
    if (atlas === 'village') return route.fulfill({ status: 404, body: 'Asset unavailable' })
    if (atlas === 'beginner') return route.fulfill({ contentType: 'image/png', body: 'Decode failure fixture' })
    return route.continue()
  })
  await installAtlasAudit(page)
  await page.goto('/')
  await Promise.all([missing, corrupt])
  await expect(page.getByLabel('目前地圖')).toHaveText('Village')
  const canvas = page.getByRole('img', { name: canvasName })
  await expect(canvas).toBeVisible()
  await canvas.screenshot({ path: testInfo.outputPath('village-fallback.png') })
  await page.getByRole('region', { name: '平台測試場' }).focus()
  await page.keyboard.down('ArrowRight')
  await expect(page.getByLabel('Beginner 狀態')).toContainText('跑步')
  await page.keyboard.up('ArrowRight')
  expect(await readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
  expect(errors).toEqual([])
})
