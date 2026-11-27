import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { followCamera, viewportScale } from '../../apps/client/src/rendering/camera.ts'
import { forestOrganicTerrainCells, forestTerrainCells } from '../../apps/client/src/rendering/forest-terrain.ts'
import { bodySize, mapById, planGrayboxTour } from '../../packages/simulation/test/graybox-walkthrough.mjs'
import { installAtlasAudit, readAtlasAudit } from '../smoke/atlas-audit.mjs'
import { installFrameClock } from '../smoke/frame-clock.mjs'

const forestPng = /\/game-assets\/forest-[a-z-]+\.[a-f0-9]{16}\.png$/
const worldCanvas = (page) => page.getByRole('img', { name: 'Beginner 平台場景' })
const currentMap = (page) => page.getByLabel('目前地圖')
const hud = (page) => page.getByLabel('Beginner 狀態')
const portalHint = (page) => page.getByText('按 ↑／W 或點觸控 ↑ 進入傳送門')
const stage = (page) => page.getByRole('region', { name: '平台測試場' })
const landscape = { viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const forestTextures = { '2172x724': 'parallax', '108x108': 'rectangular', '1339x727': 'organic' }
const forestMap = mapById.get('m1')
const rectangularCellCount = forestTerrainCells(forestMap).length
const organicCellCount = forestOrganicTerrainCells(forestMap).length
const rectangularStats = `L4 0.04 MiB / ${rectangularCellCount} 段`
const organicStats = `L4 3.71 MiB / ${organicCellCount} 段`
const modeButton = (page, name) => page.getByRole('group', { name: '渲染模式' }).getByRole('button', { name })

function pageErrors(page) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function checkForestTextures(page, draw, count) {
  const expected = Array(count).fill('parallax')
  if (count) expected.unshift('organic')
  await expect
    .poll(
      async () => {
        await draw(0)
        const { bitmaps, textures } = await readAtlasAudit(page)
        const experimental = (id) => Object.values(forestTextures).includes(id)
        return { bitmaps: bitmaps.filter(experimental), textures: textures.filter(experimental) }
      },
      { timeout: 15_000 }
    )
    .toEqual({ bitmaps: expected, textures: expected })
  const surface = page.locator('.playground-canvas')
  await expect(surface).toHaveAttribute('data-parallax-textures', String(count))
  await expect(surface).toHaveAttribute('data-parallax-layers', String(count))
  await expect(surface).toHaveAttribute('data-terrain-cells', count ? String(organicCellCount) : '0')
}

async function holdTowardPortal(page, draw, direction, touchSession) {
  const goingRight = direction === 'right'
  const key = goingRight ? 'ArrowRight' : 'ArrowLeft'
  if (touchSession) {
    const control = page.getByRole('button', { name: goingRight ? '向右' : '向左' })
    const { x, y, width, height } = await control.boundingBox()
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + width / 2, y: y + height / 2 }] })
  } else {
    await stage(page).focus()
    await page.keyboard.down(key)
  }
  for (let step = 0; step < 50 && !(await portalHint(page).isVisible()); step++) await draw(3)
  if (touchSession) await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  else await page.keyboard.up(key)
  await expect(portalHint(page)).toBeVisible()
  if (touchSession) await page.getByRole('button', { name: '進入傳送門' }).tap()
  else await page.keyboard.press('KeyW')
  await draw(1)
}

async function assertForestPixels(canvas, withArt) {
  const { width, height } = await canvas.boundingBox()
  const map = mapById.get('m1')
  const { position } = map.spawns.find(({ id }) => id === 'spawn_from_village')
  const feet = { x: position.x + bodySize.width / 2, y: position.y + bodySize.height }
  const { origin, scale } = followCamera({ x: feet.x, y: feet.y - bodySize.height / 2 }, map.bounds, { width, height })
  const png = await canvas.screenshot({ scale: 'css' })
  const colors = await canvas.evaluate(
    async (_, { png, x, y }) => {
      const response = await globalThis.fetch(`data:image/png;base64,${png}`)
      const bitmap = await globalThis.createImageBitmap(await response.blob())
      const ctx = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const [red, , blue] = ctx.getImageData(15, 15, 1, 1).data
      const { data } = ctx.getImageData(Math.round(x) - 3, Math.round(y) - 3, 7, 7)
      const player = data.some((r, i) => i % 4 === 0 && Math.abs(r - 255) + Math.abs(data[i + 1] - 188) + Math.abs(data[i + 2] - 103) < 45)
      return { warm: red > blue + 35, player }
    },
    { png: png.toString('base64'), x: (feet.x - origin.x) * scale, y: (feet.y - 21 - origin.y) * scale }
  )
  expect(colors).toEqual({ warm: withArt, player: true })
}

async function fillCamera(page, draw, { x, y, zoom }, terrain = organicStats) {
  await page.getByLabel('相機 X', { exact: true }).fill(String(x))
  await page.getByLabel('相機 Y', { exact: true }).fill(String(y))
  await page.getByLabel('相機縮放').fill(String(zoom))
  await expect
    .poll(async () => {
      await draw(16)
      return page.getByLabel('效能').textContent()
    })
    .toContain(`X ${x} · ${terrain}`)
}

async function checkForegroundPixels(page, draw, camera, path) {
  const canvas = worldCanvas(page)
  const { width, height } = await canvas.boundingBox()
  const scale = viewportScale({ width, height }) * camera.zoom
  const layer = page.getByRole('group', { name: 'forest-foreground' }).getByLabel('顯示')
  await layer.check()
  await draw(0)
  const withForeground = await canvas.screenshot({ path, scale: 'css' })
  await layer.uncheck()
  await draw(0)
  const withoutForeground = await canvas.screenshot({ scale: 'css' })
  await layer.check()
  await draw(0)
  const diff = await canvas.evaluate(
    async (_, { images, camera, scale }) => {
      const pixels = await Promise.all(
        images.map(async (image) => {
          const response = await globalThis.fetch(`data:image/png;base64,${image}`)
          const bitmap = await globalThis.createImageBitmap(await response.blob())
          const ctx = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
          ctx.drawImage(bitmap, 0, 0)
          const result = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
          bitmap.close()
          return result
        })
      )
      const [a, b] = pixels
      let within = 0
      let outside = 0
      for (let y = 0; y < a.height; y += 2) {
        for (let x = 0; x < a.width; x += 2) {
          const index = (y * a.width + x) * 4
          if (
            Math.abs(a.data[index] - b.data[index]) +
              Math.abs(a.data[index + 1] - b.data[index + 1]) +
              Math.abs(a.data[index + 2] - b.data[index + 2]) <
            12
          )
            continue
          const worldX = camera.x + x / scale
          const worldY = camera.y + y / scale
          const tolerance = 2 / scale
          const supported = worldX >= -tolerance && worldX <= 4096 + tolerance && (worldX < 1248 + tolerance || worldX > 1432 - tolerance)
          if (supported && worldY >= 928 - tolerance && worldY <= 1024 + tolerance) within++
          else outside++
        }
      }
      return { within, outside }
    },
    { images: [withForeground, withoutForeground].map((png) => png.toString('base64')), camera, scale }
  )
  expect(diff.within).toBeGreaterThan(50)
  expect(diff.outside).toBe(0)
}

async function recordPreviewPerformance(page, browser, testInfo, mode) {
  await worldCanvas(page).scrollIntoViewIfNeeded()
  const result = await page.evaluate(async () => {
    const canvas = globalThis.document.querySelector('.preview-canvas canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    const debug = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null
    const intervals = []
    const start = await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
    let previous = start
    while (previous - start < 5000) {
      const now = await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
      intervals.push(now - previous)
      previous = now
    }
    intervals.sort((a, b) => a - b)
    return {
      samples: intervals.length,
      seconds: (previous - start) / 1000,
      fps: (intervals.length * 1000) / (previous - start),
      frameP50Ms: intervals[Math.floor(intervals.length * 0.5)],
      frameP95Ms: intervals[Math.floor(intervals.length * 0.95)],
      dpr: globalThis.devicePixelRatio,
      renderer,
    }
  })
  const path = testInfo.outputPath(`preview-frame-${mode}.json`)
  await writeFile(path, JSON.stringify({ mode, browser: browser.version(), ...result }, null, 2) + '\n')
  await testInfo.attach('preview-frame-sample', { path, contentType: 'application/json' })
}

test('desktop preview edits transforms, toggles display and tiling, exports JSON and resets', async ({
  page,
  browser,
  context,
}, testInfo) => {
  const errors = pageErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/parallax.html')
  const canvas = worldCanvas(page)
  const performance = page.getByLabel('效能')
  await expect(canvas).toBeVisible()
  await expect(performance).toContainText('23.99 MiB RGBA8 · 4/4')
  await expect(performance).toContainText(organicStats)
  await expect(page.getByRole('group', { name: 'forest-foreground' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('preview-desktop.png'), fullPage: true, scale: 'css' })
  await page.getByRole('button', { name: '手機橫向' }).click()
  await expect(canvas).toHaveJSProperty('width', 667)
  await expect(canvas).toHaveJSProperty('height', 375)
  const sky = page.getByRole('group', { name: 'forest-sky' })
  const near = page.getByRole('group', { name: 'forest-near-trees' })
  await sky.getByLabel('水平重複').check()
  await near.getByLabel('顯示').uncheck()
  await near.getByLabel('X 因子').fill('-0.4')
  await near.getByLabel('Y 因子').fill('0.5')
  await near.getByLabel('縮放', { exact: true }).fill('1.4')
  await near.getByLabel('X 位移').fill('105')
  await near.getByLabel('Y 位移').fill('44')
  await near.getByLabel('不透明度').fill('0.5')
  await page.getByLabel('相機 X', { exact: true }).fill('-280')
  await page.getByLabel('相機 Y', { exact: true }).fill('-32')
  await page.getByLabel('相機縮放').fill('1.25')
  await expect(performance).toContainText('X -280')
  await page.getByRole('button', { name: '複製 JSON' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已複製設定' })).toBeVisible()
  const exported = await page.evaluate(async () => JSON.parse(await globalThis.navigator.clipboard.readText()))
  expect(exported.mapId).toBe('m1')
  expect(exported.mode).toBe('organic')
  expect(exported.layers[0]).toMatchObject({ assetId: 'forest-sky', repeatX: true })
  expect(exported.layers[3]).toMatchObject({
    visible: false,
    factorX: -0.4,
    factorY: 0.5,
    scale: 1.4,
    offsetX: 105,
    offsetY: 44,
    opacity: 0.5,
  })
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下載 JSON' }).click()
  const download = await downloadPromise
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(exported)
  await page.getByRole('button', { name: '重設' }).click()
  await expect(canvas).toHaveJSProperty('width', 1280)
  await expect(canvas).toHaveJSProperty('height', 720)
  await expect(near.getByLabel('顯示')).toBeChecked()
  await expect(sky.getByLabel('水平重複')).not.toBeChecked()
  await expect(page.getByLabel('相機 X', { exact: true })).toHaveValue('0')
  await page.getByLabel('水平自動移動').check()
  await expect(performance).toHaveText(/ X [1-9]/)
  await recordPreviewPerformance(page, browser, testInfo, 'organic')
  await page.getByRole('button', { name: '重設' }).click()
  await modeButton(page, 'VF.2 矩形').click()
  await expect(performance).toContainText(rectangularStats)
  await expect(performance).toContainText('29.99 MiB RGBA8 · 5/5')
  await page.getByLabel('水平自動移動').check()
  await expect(performance).toHaveText(/ X [1-9]/)
  await recordPreviewPerformance(page, browser, testInfo, 'rectangular')
  expect(errors).toEqual([])
})

test('desktop keyboard completes three Forest Entrance round trips and frees parallax display objects and WebGL textures', async ({
  page,
}, testInfo) => {
  const errors = pageErrors(page)
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, forestTextures)
  const requested = []
  page.on('request', (request) => {
    if (forestPng.test(request.url())) requested.push(request.url())
  })
  await page.goto('/?parallax=1')
  const canvas = worldCanvas(page)
  await expect(canvas).toBeVisible()
  await draw(0)
  await expect(currentMap(page)).toHaveText('Village')
  await checkForestTextures(page, draw, 0)
  expect(requested).toHaveLength(0)
  const initial = await canvas.elementHandle()
  for (let iteration = 0; iteration < 3; iteration++) {
    await holdTowardPortal(page, draw, iteration === 0 ? 'right' : 'left')
    await expect(currentMap(page)).toHaveText('Forest Entrance')
    await checkForestTextures(page, draw, 4)
    expect(requested.some((url) => url.includes('forest-foreground'))).toBe(false)
    await expect(hud(page)).toContainText('HP')
    if (iteration === 0) {
      await assertForestPixels(canvas, true)
      await page.screenshot({ path: testInfo.outputPath('forest-desktop.png'), fullPage: true, scale: 'css' })
    }
    await holdTowardPortal(page, draw, 'left')
    await expect(currentMap(page)).toHaveText('Village')
    await checkForestTextures(page, draw, 0)
    expect(await initial.evaluate((element) => element.isConnected)).toBe(true)
  }
  await expect(canvas).toHaveCount(1)
  await page.getByRole('button', { name: '卸載場景' }).click()
  await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
  expect(errors).toEqual([])
})

test('failed parallax PNG loads fall back to the playable Forest Entrance graybox', async ({ page }) => {
  const errors = pageErrors(page)
  const draw = await installFrameClock(page)
  let failed = 0
  await page.route(forestPng, (route) => {
    failed++
    return route.fulfill({ status: 404 })
  })
  await page.goto('/?parallax=1')
  const canvas = worldCanvas(page)
  await expect(canvas).toBeVisible()
  await draw(0)
  await holdTowardPortal(page, draw, 'right')
  await expect(currentMap(page)).toHaveText('Forest Entrance')
  await expect.poll(() => failed).toBe(5)
  await expect(page.locator('.playground-canvas')).toHaveAttribute('data-parallax-textures', '0')
  await expect(page.locator('.playground-canvas')).toHaveAttribute('data-terrain-cells', '0')
  await assertForestPixels(canvas, false)
  await expect(hud(page)).toContainText('HP')
  await holdTowardPortal(page, draw, 'left')
  await expect(currentMap(page)).toHaveText('Village')
  expect(errors).toEqual([])
})

test('terrain preview preserves the gap and aligns foreground and collision overlay at multiple camera positions', async ({
  page,
}, testInfo) => {
  const errors = pageErrors(page)
  const draw = await installFrameClock(page)
  await page.goto('/parallax.html')
  await modeButton(page, 'VF.2 矩形').click()
  await expect(worldCanvas(page)).toBeVisible()
  const gap = { x: 840, y: 370, zoom: 1 }
  await fillCamera(page, draw, gap, rectangularStats)
  await checkForegroundPixels(page, draw, gap, testInfo.outputPath('gap-foreground.png'))
  await page.getByLabel('碰撞邊界').check()
  await draw(0)
  await worldCanvas(page).screenshot({ path: testInfo.outputPath('gap-collision.png'), scale: 'css' })
  await modeButton(page, '灰盒').click()
  await draw(0)
  await worldCanvas(page).screenshot({ path: testInfo.outputPath('gap-graybox.png'), scale: 'css' })
  await modeButton(page, 'VF.2 矩形').click()
  await page.getByLabel('碰撞邊界').uncheck()
  const raised = { x: 1680, y: 490, zoom: 1.35 }
  await fillCamera(page, draw, raised, rectangularStats)
  await checkForegroundPixels(page, draw, raised, testInfo.outputPath('raised-platforms.png'))
  expect(errors).toEqual([])
})

test('organic terrain comparison preserves caps and complete repeats across the seven surfaces', async ({ page }, testInfo) => {
  const errors = pageErrors(page)
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, forestTextures)
  await page.goto('/parallax.html')
  const canvas = worldCanvas(page)
  const gap = { x: 850, y: 605, zoom: 1.65 }
  const checkTextures = async (expected) => {
    await expect
      .poll(
        async () => {
          await draw(0)
          const { bitmaps, textures } = await readAtlasAudit(page)
          const forestOnly = (ids) => ids.filter((id) => Object.values(forestTextures).includes(id))
          return { bitmaps: forestOnly(bitmaps), textures: forestOnly(textures) }
        },
        { timeout: 15_000 }
      )
      .toEqual({ bitmaps: expected, textures: expected })
  }
  const capture = (name) => canvas.screenshot({ path: testInfo.outputPath(`${name}.png`), scale: 'css' })

  await checkTextures(['organic', ...Array(4).fill('parallax')])
  await fillCamera(page, draw, gap)
  await capture('gap-organic')
  await page.getByLabel('碰撞邊界').check()
  await draw(0)
  await capture('gap-organic-collision')
  await page.getByLabel('碰撞邊界').uncheck()

  await modeButton(page, 'VF.2 矩形').click()
  await checkTextures([...Array(5).fill('parallax'), 'rectangular'])
  await capture('gap-rectangular')
  await modeButton(page, '灰盒').click()
  await checkTextures([])
  await capture('gap-graybox')
  await modeButton(page, 'VF.2.1 自然地形').click()
  await checkTextures(['organic', ...Array(4).fill('parallax')])
  await expect(canvas).toHaveCount(1)

  const shots = [
    ['west-cliff', { x: -112, y: 655, zoom: 1.7 }],
    ['west-platforms', { x: 305, y: 640, zoom: 2.1 }],
    ['east-platforms', { x: 1780, y: 590, zoom: 1.9 }],
    ['east-ground', { x: 2510, y: 304, zoom: 1 }],
    ['east-join', { x: 2845, y: 788, zoom: 3.2 }],
    ['east-cliff', { x: 3475, y: 655, zoom: 1.7 }],
  ]
  for (const [name, camera] of shots) {
    await fillCamera(page, draw, camera)
    await capture(name)
    if (name.endsWith('platforms')) {
      await page.getByLabel('碰撞邊界').check()
      await draw(0)
      await capture(`${name}-collision`)
      await page.getByLabel('碰撞邊界').uncheck()
    }
  }
  expect(errors).toEqual([])
})

test('player, Slime and a projected loot item draw immediately above the imported ground surface', async ({ page }, testInfo) => {
  const errors = pageErrors(page)
  await installAtlasAudit(page, forestTextures)
  await page.route('**/parallax.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Forest footing fixture</title>' })
  )
  await page.goto('/parallax.html')
  const camera = { x: 150, y: 480, zoom: 1.5 }
  const spawn = forestMap.spawns.find(({ id }) => id === 'spawn_from_village')
  const slime = forestMap.monsterSpawns.find(({ monsterArchetypeId }) => monsterArchetypeId === 'slime')
  const lootX = spawn.position.x + bodySize.width / 2 + 64
  const floor = spawn.position.y + bodySize.height
  await page.evaluate(
    async ({ map, body, spawn, camera, lootX, floor }) => {
      const entry = '/src/rendering/world-renderer.ts'
      const { createWorldRenderer } = await import(entry)
      const host = globalThis.document.createElement('div')
      host.style.cssText = 'width:80rem;height:45rem'
      globalThis.document.body.style.margin = '0'
      globalThis.document.body.append(host)
      const controller = new globalThis.AbortController()
      const renderer = await createWorldRenderer(host, body, controller.signal, { diagnostics: true, previewParallax: true })
      const config = '/src/rendering/forest-parallax.ts'
      const { organicForestParallax } = await import(config)
      const groundLoot = new Map([
        [
          'fixture-loot',
          {
            lootId: 'fixture-loot',
            position: { x: lootX, y: floor },
            expiresAtUtcMilliseconds: 1,
            content: { kind: 'currency', amount: 1 },
          },
        ],
      ])
      globalThis.drawFootingSample = () =>
        renderer.render(
          { map, position: spawn.position, state: 'idle', facing: spawn.facing, visualTick: 0, groundLoot },
          { origin: { x: camera.x, y: camera.y }, zoom: camera.zoom, layers: organicForestParallax, mode: 'organic', showCollision: false }
        )
    },
    { map: forestMap, body: bodySize, spawn, camera, lootX, floor }
  )
  await expect
    .poll(async () => {
      await page.evaluate(() => globalThis.drawFootingSample())
      return readAtlasAudit(page)
    })
    .toEqual({
      bitmaps: ['beginner', 'field', 'organic', ...Array(4).fill('parallax')],
      textures: ['beginner', 'field', 'organic', ...Array(4).fill('parallax')],
    })
  const canvas = worldCanvas(page)
  const screenshot = await canvas.screenshot({ path: testInfo.outputPath('forest-footing.png'), scale: 'css' })
  const points = [
    { worldX: spawn.position.x + bodySize.width / 2, rgb: [72, 87, 113], worldY: floor - 3 },
    { worldX: slime.position.x, rgb: [86, 185, 144], worldY: floor - 5 },
    { worldX: lootX, rgb: [255, 209, 102], worldY: floor - 9 },
  ]
  const aligned = await canvas.evaluate(
    async (_, { png, points, camera, floor }) => {
      const response = await globalThis.fetch(`data:image/png;base64,${png}`)
      const bitmap = await globalThis.createImageBitmap(await response.blob())
      const ctx = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return points.map(({ worldX, worldY, rgb }) => {
        const x = Math.round((worldX - camera.x) * camera.zoom)
        const y = Math.round((worldY - camera.y) * camera.zoom)
        const { data } = ctx.getImageData(x - 9, y - 5, 18, 10)
        const entity = data.some(
          (r, i) => i % 4 === 0 && Math.abs(r - rgb[0]) + Math.abs(data[i + 1] - rgb[1]) + Math.abs(data[i + 2] - rgb[2]) < 24
        )
        const [red, green, blue] = ctx.getImageData(x, Math.ceil((floor - camera.y + 2) * camera.zoom), 1, 1).data
        return entity && red > green + 35 && green > blue + 20
      })
    },
    { png: screenshot.toString('base64'), points, camera, floor }
  )
  expect(aligned).toEqual([true, true, true])
  expect(errors).toEqual([])
})

test('keyboard jumps across the Forest Entrance gap and transfers through Deep Forest with one canvas', async ({ page }, testInfo) => {
  test.slow()
  const errors = pageErrors(page)
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, forestTextures)
  await page.goto('/?parallax=1')
  const canvas = worldCanvas(page)
  await expect(canvas).toBeVisible()
  await draw(0)
  await expect(currentMap(page)).toHaveText('Village')
  await stage(page).focus()
  const initial = await canvas.elementHandle()
  let held = 0
  for (const { approachInputs, map } of planGrayboxTour().slice(0, 3)) {
    for (let index = 0; index < approachInputs.length;) {
      const { moveX = 0, jumpPressed } = approachInputs[index]
      if (held !== moveX) {
        if (held) await page.keyboard.up(held < 0 ? 'ArrowLeft' : 'ArrowRight')
        if (moveX) await page.keyboard.down(moveX < 0 ? 'ArrowLeft' : 'ArrowRight')
        held = moveX
      }
      if (jumpPressed) await page.keyboard.press('Space')
      let end = index + 1
      while (end < approachInputs.length && (approachInputs[end].moveX ?? 0) === moveX && !approachInputs[end].jumpPressed) end++
      await draw(end - index)
      index = end
    }
    await expect(portalHint(page)).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await draw(1)
    await expect(currentMap(page)).toHaveText(map.id === 'm1' ? 'Forest Entrance' : 'Deep Forest')
    await checkForestTextures(page, draw, map.id === 'm1' ? 4 : 0)
    expect(await initial.evaluate((element) => element.isConnected)).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('forest-east.png'), fullPage: true, scale: 'css' })
  expect(errors).toEqual([])
})

test.describe('mobile landscape at DPR 2', () => {
  test.use(landscape)

  test('touch switches preview preset and moves the camera at 667 × 375', async ({ page, browser }, testInfo) => {
    const errors = pageErrors(page)
    await page.goto('/parallax.html')
    await page.getByRole('button', { name: '手機橫向' }).tap()
    const canvas = worldCanvas(page)
    await expect(canvas).toHaveJSProperty('width', 1334)
    await expect(canvas).toHaveJSProperty('height', 750)
    const performance = page.getByLabel('效能')
    await expect(performance).toContainText('23.99 MiB RGBA8 · 4/4')
    await expect(performance).toContainText(organicStats)
    await page.screenshot({ path: testInfo.outputPath('preview-mobile.png'), fullPage: true, scale: 'css' })
    await page.getByLabel('水平自動移動').tap()
    await expect(page.getByLabel('效能')).toHaveText(/ X [1-9]/)
    await recordPreviewPerformance(page, browser, testInfo, 'organic')
    await page.getByRole('button', { name: '重設' }).tap()
    await page.getByRole('button', { name: '手機橫向' }).tap()
    await modeButton(page, 'VF.2 矩形').tap()
    await expect(performance).toContainText(rectangularStats)
    await expect(performance).toContainText('29.99 MiB RGBA8 · 5/5')
    await page.getByLabel('水平自動移動').tap()
    await expect(performance).toHaveText(/ X [1-9]/)
    await recordPreviewPerformance(page, browser, testInfo, 'rectangular')
    expect(errors).toEqual([])
  })

  test('touch enters and exits Forest Entrance with one canvas and the existing HUD', async ({ page, context }, testInfo) => {
    const errors = pageErrors(page)
    const draw = await installFrameClock(page)
    await installAtlasAudit(page, forestTextures)
    await page.goto('/?parallax=1')
    await expect(worldCanvas(page)).toBeVisible()
    await draw(0)
    const session = await context.newCDPSession(page)
    await holdTowardPortal(page, draw, 'right', session)
    await expect(currentMap(page)).toHaveText('Forest Entrance')
    await checkForestTextures(page, draw, 4)
    await expect(hud(page)).toBeVisible()
    await assertForestPixels(worldCanvas(page), true)
    await page.screenshot({ path: testInfo.outputPath('forest-mobile.png'), fullPage: true, scale: 'css' })
    await holdTowardPortal(page, draw, 'left', session)
    await expect(currentMap(page)).toHaveText('Village')
    await checkForestTextures(page, draw, 0)
    await expect(worldCanvas(page)).toHaveCount(1)
    expect(errors).toEqual([])
  })
})
