import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { followCamera } from '../../apps/client/src/rendering/camera.ts'
import { startBrowserFixtureServer } from '../../apps/server/test/browser-fixture-server.mjs'
import characterManifest from '../../content/assets/experimental-character.json' with { type: 'json' }
import { bodySize, createWalkthrough, mapById } from '../../packages/simulation/test/graybox-walkthrough.mjs'
import { installAtlasAudit, readAtlasAudit } from '../smoke/atlas-audit.mjs'
import { installFrameClock } from '../smoke/frame-clock.mjs'

const previewUrl = '/?parallax=1&character=1'
const texturePattern = /\/game-assets\/beginner-(?:base-body(?:-idle)?|static)-atlas\.[a-f0-9]{16}\.png$/
const atlasDimensions = {
  ...Object.fromEntries(characterManifest.atlases.map(({ width, height }) => [`${width}x${height}`, 'character'])),
  '2172x724': 'parallax',
  '1339x727': 'terrain',
}
const canvas = (page) => page.getByRole('img', { name: 'Beginner 平台場景' })
const stage = (page) => page.getByRole('region', { name: '平台測試場' })
const mapLabel = (page) => page.getByLabel('目前地圖')
const previewButton = (page) => page.getByText('角色預覽', { exact: true })
const hud = (page) => page.getByLabel('Beginner 狀態')
const appearance = (page) => page.locator('.playground-canvas').evaluate((host) => JSON.parse(host.dataset.appearance ?? 'null'))

test('Face 01 appearance continuity during keyboard turns and movement', async ({ page }, testInfo) => {
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, atlasDimensions)
  await page.goto('/?character=1&appearanceDiagnostics=1')
  await expect(canvas(page)).toBeVisible()
  await draw(30)
  await previewButton(page).click()
  await page.getByLabel('角色素材').selectOption('paper-doll')
  await expectCharacterTextures(page, draw, 3)
  await previewButton(page).click()
  await stage(page).focus()
  const samples = []
  async function record(step, ticks) {
    for (let index = 0; index < ticks; index++) {
      await draw(1)
      samples.push({ step, ...(await appearance(page)) })
    }
  }
  await record('idle', 2)
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    await page.keyboard.down(key)
    await record(`tap-${key}`, 3)
    await page.keyboard.up(key)
    await record('released', 4)
  }
  await page.keyboard.down('ArrowLeft')
  await record('held-left', 12)
  await page.keyboard.up('ArrowLeft')
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowLeft']) {
    await page.keyboard.down(key)
    await record(`alternating-${key}`, 2)
    await page.keyboard.up(key)
  }
  await record('stopped', 12)
  await writeFile(testInfo.outputPath('local-appearance.json'), JSON.stringify(samples, null, 2) + '\n')
  expect(samples.filter(({ local }) => local.renderState === 'run').map(({ local }) => local.facing)).toEqual(
    expect.arrayContaining(['left', 'right'])
  )
  expect(samples.at(-1).local.renderState).toBe('idle')
  expect(samples.filter(({ local, faceTextureAvailable }) => !local.faceVisible || !faceTextureAvailable)).toEqual([])
  const neutralAttachments = samples[0].local.attachments
  for (const { local } of samples.filter(({ local }) => local.renderState === 'run')) {
    expect(local).toMatchObject({ pose: 'neutral', frameIndex: 0, attachments: neutralAttachments, order: 'baseBody → face' })
  }
  await page.getByRole('button', { name: '卸載場景' }).click()
  await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
})

async function expectCharacterTextures(page, draw = () => {}, count = 1) {
  await expect
    .poll(async () => {
      await draw(0)
      const audit = await readAtlasAudit(page)
      return Object.values(audit).map((ids) => ids.filter((id) => id === 'character').length)
    })
    .toEqual([count, count])
}

async function capture(page, testInfo, filename) {
  return page.screenshot({ path: testInfo.outputPath(filename + '.png'), scale: 'device', fullPage: true })
}

async function avatarPixels(page, map, target, positions, checkFoot = false) {
  const surface = canvas(page)
  const { width, height } = await surface.boundingBox()
  const center = { x: target.x + bodySize.width / 2, y: target.y + bodySize.height / 2 }
  const camera = followCamera(center, map.bounds, { width, height })
  const feet = positions.map((position) => ({
    x: Math.round((position.x + bodySize.width / 2 - camera.origin.x) * camera.scale),
    y: Math.round((position.y + bodySize.height - camera.origin.y) * camera.scale),
  }))
  const png = await surface.screenshot({ scale: 'css' })
  return page.evaluate(
    async ({ png, feet, scale, checkFoot }) => {
      const source = await globalThis.fetch(`data:image/png;base64,${png}`)
      const bitmap = await globalThis.createImageBitmap(await source.blob())
      const ctx = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return feet.map(({ x, y }) => {
        const head = ctx.getImageData(
          x - Math.round(20 * scale),
          y - Math.round(85 * scale),
          Math.round(40 * scale),
          Math.round(28 * scale)
        )
        let skinPixels = 0
        for (let i = 0; i < head.data.length; i += 4) {
          const [red, green, blue] = head.data.subarray(i, i + 3)
          if (red > 229 && green > 188 && red - green >= 6 && blue > green - 24 && blue <= green + 4) skinPixels++
        }
        const foot = ctx.getImageData(x - 2, y - 2, 5, 5)
        const marked = foot.data.some((red, i) => i % 4 === 0 && red > 240 && foot.data[i + 1] > 195 && foot.data[i + 2] < 140)
        return skinPixels > 25 && (!checkFoot || marked)
      })
    },
    { png: png.toString('base64'), feet, scale: camera.scale, checkFoot }
  )
}

async function recordLiveFps(page, browser, testInfo, name) {
  await canvas(page).scrollIntoViewIfNeeded()
  const sample = await canvas(page).evaluate(async (element) => {
    const gl = element.getContext('webgl2') ?? element.getContext('webgl')
    const debug = gl?.getExtension('WEBGL_debug_renderer_info')
    const intervals = []
    const next = () => new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
    const start = await next()
    let previous = start
    while (previous - start < 5000) {
      const now = await next()
      intervals.push(now - previous)
      previous = now
    }
    intervals.sort((a, b) => a - b)
    return {
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight, dpr: globalThis.devicePixelRatio },
      canvas: { width: element.clientWidth, height: element.clientHeight },
      seconds: (previous - start) / 1000,
      samples: intervals.length,
      fps: (intervals.length * 1000) / (previous - start),
      p50Ms: intervals[Math.floor(intervals.length * 0.5)],
      p95Ms: intervals[Math.floor(intervals.length * 0.95)],
    }
  })
  expect(sample.samples).toBeGreaterThan(0)
  await writeFile(testInfo.outputPath(name + '.json'), JSON.stringify({ chromium: browser.version(), ...sample }, null, 2) + '\n')
}

test('compares the three modes in Village and Base Body facing and footing in Forest Entrance across three round trips', async ({
  page,
}, testInfo) => {
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, atlasDimensions)
  const requested = []
  const errors = []
  page.on('request', (request) => {
    if (texturePattern.test(request.url())) requested.push(request.url())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(previewUrl)
  await expect(canvas(page)).toBeVisible()
  const original = await canvas(page).elementHandle()
  const plan = createWalkthrough()
  let played = 0
  let held = 0

  async function play() {
    await stage(page).focus()
    for (let index = played; index < plan.trace.length;) {
      const { moveX = 0, jumpPressed, portalPressed } = plan.trace[index].input
      if (held !== moveX) {
        if (held) await page.keyboard.up(held < 0 ? 'ArrowLeft' : 'ArrowRight')
        if (moveX) await page.keyboard.down(moveX < 0 ? 'ArrowLeft' : 'ArrowRight')
        held = moveX
      }
      if (jumpPressed) await page.keyboard.press('Space')
      if (portalPressed) await page.keyboard.press('ArrowUp')
      let end = index + 1
      while (end < plan.trace.length) {
        const next = plan.trace[end].input
        if ((next.moveX ?? 0) !== moveX || next.jumpPressed || next.portalPressed) break
        end++
      }
      await draw(end - index)
      index = end
    }
    played = plan.trace.length
  }

  async function captureStand(name, feetY, foot = false) {
    expect(plan.feetY()).toBe(feetY)
    await expect(hud(page)).toContainText('待機')
    const { position } = plan.player()
    expect(await avatarPixels(page, plan.map(), position, [position], foot)).toEqual([true])
    await capture(page, testInfo, name)
  }

  function transfer(destination) {
    plan.approach('p_to_' + destination)
    plan.advance({ portalPressed: true })
    plan.advance()
  }

  await expectCharacterTextures(page, draw)
  expect(requested).toHaveLength(1)
  expect(requested[0]).toContain('/beginner-base-body-atlas.')
  await expect(mapLabel(page)).toHaveText('Village')
  await captureStand('village', plan.feetY())
  await previewButton(page).click()
  const mode = page.getByLabel('角色素材')
  const height = page.getByLabel('角色高度')
  await expect(mode).toHaveValue('base-body')
  await expect(height).toHaveValue('80')
  expect(await height.locator('option').allTextContents()).toEqual(['48', '56', '64', '72', '80', '90'])
  await mode.selectOption('character-master')
  await expect(height).toHaveValue('64')
  await expectCharacterTextures(page, draw, 2)
  await previewButton(page).click()
  await capture(page, testInfo, 'village-character-master')
  await previewButton(page).click()
  await mode.selectOption('legacy')
  await expect(height).toBeDisabled()
  await expect(height.locator('option:checked')).toHaveText('原始尺寸')
  await draw(0)
  await previewButton(page).click()
  await capture(page, testInfo, 'village-legacy')
  await previewButton(page).click()
  await mode.selectOption('base-body')
  await expect(height).toHaveValue('80')
  await previewButton(page).click()

  transfer('m1')
  await play()
  await expect(mapLabel(page)).toHaveText('Forest Entrance')
  await expect
    .poll(async () => {
      await draw(0)
      return (await readAtlasAudit(page)).textures.filter((id) => id === 'parallax' || id === 'terrain')
    })
    .toEqual(['parallax', 'parallax', 'parallax', 'parallax', 'terrain'])
  await captureStand('forest-desktop', 896)
  plan.walkTo(420)
  plan.advance()
  await play()
  await captureStand('forest-slime-right', 896)

  await previewButton(page).click()
  await height.selectOption('64')
  await previewButton(page).click()
  await draw(0)
  await capture(page, testInfo, 'forest-slime-64')

  await previewButton(page).click()
  await height.selectOption('90')
  await page.getByLabel('本機角色朝向').selectOption('left')
  await previewButton(page).click()
  await draw(0)
  await captureStand('forest-slime-left', 896)
  await previewButton(page).click()
  await page.getByLabel('角色碰撞框').check()
  await page.getByLabel('腳底錨點').check()
  await page.getByLabel('本機角色朝向').selectOption('gameplay')
  await previewButton(page).click()
  await draw(0)
  await captureStand('forest-collision', 896, true)

  plan.walkTo(460)
  plan.hop()
  plan.advance()
  await play()
  await captureStand('forest-thin', 824, true)
  plan.walkTo(510)
  plan.hop(1)
  plan.settle()
  plan.advance()
  await play()
  await captureStand('forest-thick', 816, true)

  for (let iteration = 0; iteration < 3; iteration++) {
    if (iteration > 0) {
      transfer('m1')
      await play()
      await expect(mapLabel(page)).toHaveText('Forest Entrance')
      await expectCharacterTextures(page, draw, 2)
    }
    transfer('village')
    await play()
    await expect(mapLabel(page)).toHaveText('Village')
    await expectCharacterTextures(page, draw, 2)
    expect(await original.evaluate((element) => element.isConnected)).toBe(true)
    expect((await readAtlasAudit(page)).bitmaps).not.toContain('terrain')
  }
  expect(requested.map((url) => texturePattern.exec(url)?.[0]).sort()).toEqual(
    characterManifest.atlases
      .filter(({ id }) => /beginner-(?:static|base-body)-atlas/.test(id))
      .map(({ id, sha256 }) => `/game-assets/${id}.${sha256.slice(0, 16)}.png`)
      .sort()
  )
  await page.getByRole('button', { name: '卸載場景' }).click()
  await expect(canvas(page)).toHaveCount(0)
  await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
  expect(errors).toEqual([])
})

test('loads only on opt-in and failed preview PNGs leave the legacy sprite visible', async ({ page }) => {
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, atlasDimensions)
  let requests = 0
  await page.route(texturePattern, (route) => {
    requests++
    return route.fulfill({ status: 404 })
  })
  await page.goto('/?parallax=1')
  await expect(canvas(page)).toBeVisible()
  await draw(0)
  await expect(previewButton(page)).toHaveCount(0)
  expect(requests).toBe(0)
  await page.goto(previewUrl)
  await expect(canvas(page)).toBeVisible()
  await expect
    .poll(async () => {
      await draw(0)
      return (await readAtlasAudit(page)).textures
    })
    .toEqual(['beginner', 'village'])
  const fallback = await canvas(page).screenshot()
  await previewButton(page).click()
  const mode = page.getByLabel('角色素材')
  await mode.selectOption('character-master')
  await expect
    .poll(async () => {
      await draw(0)
      return requests
    })
    .toBe(2)
  await mode.selectOption('animated-base-body')
  await expect
    .poll(async () => {
      await draw(0)
      return requests
    })
    .toBe(3)
  await previewButton(page).click()
  await draw(0)
  expect((await canvas(page).screenshot()).equals(fallback)).toBe(true)
  await previewButton(page).click()
  await mode.selectOption('legacy')
  await previewButton(page).click()
  await draw(0)
  expect((await canvas(page).screenshot()).equals(fallback)).toBe(true)
  expect(requests).toBe(3)
})

test('Animated Base Body defaults to 0.5x and exposes pause, frame, speed and attachment controls', async ({ page }, testInfo) => {
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, atlasDimensions)
  await page.goto('/?character=1')
  await expect(canvas(page)).toBeVisible()
  await draw(2)
  await expect(mapLabel(page)).toHaveText('Village')
  await previewButton(page).click()
  await page.getByLabel('角色素材').selectOption('animated-base-body')
  await expect(page.getByLabel('角色高度')).toHaveValue('80')
  await expect(page.getByLabel('播放速度')).toHaveValue('0.5')
  await expectCharacterTextures(page, draw, 2)
  await draw(30)
  await expect(hud(page)).toContainText('待機')
  const snapshot = async () => {
    const { x, y, width, height } = await canvas(page).boundingBox()
    return page.screenshot({ clip: { x: x + width / 2 - 60, y: y + height / 2, width: 120, height: height / 2 } })
  }
  const frameSelect = page.getByLabel('動畫幀')
  const selectFrame = async (index) => {
    await frameSelect.selectOption(String(index))
    await draw(0)
    return snapshot()
  }
  const peak = await selectFrame(2)
  const inhale = await selectFrame(1)
  const neutral = await selectFrame(0)
  expect(peak.equals(neutral)).toBe(false)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await draw(3)
  const frames = [neutral, inhale, peak, inhale, neutral]
  for (const expected of frames) {
    expect((await snapshot()).equals(expected)).toBe(true)
    await draw(12)
  }
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await draw(0)
  const paused = await snapshot()
  await draw(12)
  expect((await snapshot()).equals(paused)).toBe(true)
  expect((await selectFrame(2)).equals(peak)).toBe(true)
  await page.getByLabel('播放速度').selectOption('2')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await draw(4)
  expect((await snapshot()).equals(inhale)).toBe(true)
  await page.getByLabel('掛載點').check()
  await draw(0)
  expect((await snapshot()).equals(inhale)).toBe(false)
  await capture(page, testInfo, 'animated-idle-controls')
  await page.getByRole('button', { name: '卸載場景' }).click()
  await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
})

test('Paper Doll captures four frames, verifies mirrored diagnostic pixels and handles missing layers', async ({ page }, testInfo) => {
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, atlasDimensions)
  const host = page.locator('.playground-canvas')
  const order = () => host.getAttribute('data-paper-doll-order')
  await page.goto('/?character=1')
  await expect(canvas(page)).toBeVisible()
  await draw(2)
  await previewButton(page).click()
  await page.getByLabel('角色素材').selectOption('paper-doll')
  await page.getByLabel('測試外觀圖層').check()
  await page.getByLabel('圖層順序').check()
  await page.getByLabel('腳底錨點').check()
  await expectCharacterTextures(page, draw, 3)
  const frame = page.getByLabel('動畫幀')
  const facing = page.getByLabel('本機角色朝向')
  await facing.selectOption('left')
  const plan = createWalkthrough()
  const { position } = plan.player()
  const bounds = await canvas(page).boundingBox()
  const center = { x: position.x + bodySize.width / 2, y: position.y + bodySize.height / 2 }
  const camera = followCamera(center, plan.map().bounds, bounds)
  const footX = (center.x - camera.origin.x) * camera.scale
  const footY = (position.y + bodySize.height - camera.origin.y) * camera.scale
  const radius = Math.ceil(74 * camera.scale)
  const left = Math.round(bounds.x + footX) - radius
  const top = Math.round(bounds.y + footY - 100 * camera.scale)
  const clip = { x: left, y: top, width: radius * 2, height: Math.ceil(115 * camera.scale) }
  const { idlePose } = characterManifest.atlases.find(({ id }) => id === 'beginner-base-body-idle-atlas').sprites[0]
  async function snapshot(name, frameIndex) {
    const anchor = idlePose.clips.idle.frames[frameIndex]?.attachments.face
    const scale = idlePose.worldUnitsPerPixel * camera.scale
    const face = anchor && {
      x: Math.floor(bounds.x + footX - left + (anchor.x - idlePose.pivotPx.x) * scale),
      y: Math.floor(bounds.y + footY - top + (anchor.y - idlePose.pivotPx.y) * scale),
    }
    const png = await page.screenshot({ clip, scale: 'css', path: testInfo.outputPath(name + '.png') })
    return page.evaluate(
      async ({ png, face }) => {
        const blob = await (await globalThis.fetch('data:image/png;base64,' + png)).blob()
        const bitmap = await globalThis.createImageBitmap(blob)
        const ctx = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const { width, height } = ctx.canvas
        const { data } = ctx.getImageData(0, 0, width, height)
        const colors = [
          [57, 137, 255],
          [48, 250, 148],
          [237, 66, 207],
        ]
        const boxes = colors.map((color) => {
          let minX = width,
            maxX = -1,
            minY = height,
            maxY = -1
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const offset = 4 * (y * width + x)
              if (color.every((value, channel) => Math.abs(data[offset + channel] - value) < 5)) {
                minX = Math.min(minX, x)
                maxX = Math.max(maxX, x)
                minY = Math.min(minY, y)
                maxY = Math.max(maxY, y)
              }
            }
          }
          return maxX < 0 ? null : { minX, maxX, minY, maxY }
        })
        const faceOffset = face && 4 * (face.y * width + face.x)
        const faceColor =
          faceOffset === undefined
            ? -1
            : colors.findIndex((color) => color.every((value, channel) => Math.abs(data[faceOffset + channel] - value) < 16))
        return { boxes, faceColor }
      },
      { png: png.toString('base64'), face }
    )
  }
  const all = 'backHair → baseBody → face → frontHair'
  const frames = []
  for (const [index, layers] of [all, all, 'backHair → baseBody → frontHair → face', 'backHair → baseBody → face'].entries()) {
    await frame.selectOption(String(index))
    await draw(0)
    expect(await order()).toBe(`F${index} · ${layers}`)
    const { boxes, faceColor } = await snapshot(`paper-doll-frame-${index}`, index)
    frames.push(boxes)
    expect(boxes.map(Boolean)).toEqual([true, true, index !== 3])
    expect(faceColor).toBe(index < 2 ? 2 : 1)
  }
  expect(frames[2][0].minY).toBeLessThan(frames[0][0].minY)
  expect(frames[2][2].minY).toBeLessThan(frames[0][2].minY)
  await frame.selectOption('0')
  await facing.selectOption('right')
  await draw(0)
  const { boxes: flipped } = await snapshot('paper-doll-right')
  const pivot = bounds.x + footX - left - 0.5
  const residuals = []
  for (const [index, flippedPart] of flipped.entries()) {
    const part = frames[0][index]
    const x = [flippedPart.maxX + part.minX - 2 * pivot, flippedPart.minX + part.maxX - 2 * pivot]
    const y = [flippedPart.minY - part.minY, flippedPart.maxY - part.maxY]
    expect(x.every((value) => Math.abs(value) <= 2)).toBe(true)
    expect(y.every((value) => Math.abs(value) <= 1)).toBe(true)
    residuals.push({ x, y })
  }
  await writeFile(testInfo.outputPath('diagnostic-mirror-raster.json'), JSON.stringify({ pivot, residuals }, null, 2) + '\n')
  await page.getByLabel('掛載點').check()
  await draw(0)
  await capture(page, testInfo, 'paper-doll-controls')
  await page.getByLabel('測試外觀圖層').uncheck()
  await page.getByLabel('Face 01 圖層').uncheck()
  await draw(0)
  expect(await order()).toBe('F0 · baseBody')
  expect((await snapshot('paper-doll-base-only')).boxes).toEqual([null, null, null])
  await page.getByLabel('測試外觀圖層').check()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await draw(2)
  expect(await order()).toBe(`F0 · ${all}`)
  await draw(12)
  expect(await order()).toBe(`F1 · ${all}`)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await draw(24)
  expect(await order()).toBe(`F1 · ${all}`)
  await page.getByLabel('播放速度').selectOption('2')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await draw(3)
  expect(await order()).toBe('F2 · backHair → baseBody → frontHair → face')
  await page.getByRole('button', { name: '卸載場景' }).click()
  await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
})

test('Face 01 calibrates the attached layer and captures the Idle and mirror comparisons', async ({ page, context }, testInfo) => {
  const draw = await installFrameClock(page)
  await installAtlasAudit(page, atlasDimensions)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/?character=1')
  await expect(canvas(page)).toBeVisible()
  await draw(30)
  await previewButton(page).click()
  await page.getByLabel('角色素材').selectOption('paper-doll')
  await expect(page.getByLabel('角色高度')).toHaveValue('80')
  await expect(page.getByLabel('播放速度')).toHaveValue('0.5')
  await expect(page.getByLabel('測試外觀圖層')).not.toBeChecked()
  await expectCharacterTextures(page, draw, 3)
  await page.getByLabel('圖層順序').check()
  await page.getByText('Face 01 校正', { exact: true }).click()
  const xSlider = page.getByRole('slider', { name: '水平偏移 X' })
  const ySlider = page.getByRole('slider', { name: '垂直偏移 Y' })
  const scaleSlider = page.getByRole('slider', { name: '等比縮放' })
  await expect(xSlider).toHaveValue('5.5')
  await expect(ySlider).toHaveValue('27.5')
  await expect(scaleSlider).toHaveValue('1.3')
  await xSlider.fill('0')
  await ySlider.fill('0')
  await scaleSlider.fill('1')
  const { position } = createWalkthrough().player()
  const bounds = await canvas(page).boundingBox()
  const center = { x: position.x + bodySize.width / 2, y: position.y + bodySize.height / 2 }
  const camera = followCamera(center, mapById.get('village').bounds, bounds)
  const footX = bounds.x + (center.x - camera.origin.x) * camera.scale
  const footY = bounds.y + (position.y + bodySize.height - camera.origin.y) * camera.scale
  const clip = { x: Math.round(footX) - 54, y: Math.round(footY) - 80, width: 108, height: 99 }
  const frame = page.getByLabel('動畫幀')
  const facing = page.getByLabel('本機角色朝向')
  const face = page.getByLabel('Face 01 圖層')
  const host = page.locator('.playground-canvas')
  const readOrder = () => host.getAttribute('data-paper-doll-order')
  const captureActor = async (name) => page.screenshot({ clip, scale: 'css', ...(name && { path: testInfo.outputPath(name + '.png') }) })
  const difference = async (first, second) =>
    page.evaluate(
      async ([first, second]) => {
        async function pixels(png) {
          const blob = await (await globalThis.fetch('data:image/png;base64,' + png)).blob()
          const image = await globalThis.createImageBitmap(blob)
          const ctx = new globalThis.OffscreenCanvas(image.width, image.height).getContext('2d')
          ctx.drawImage(image, 0, 0)
          image.close()
          return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height)
        }
        const [withFace, body] = await Promise.all([pixels(first), pixels(second)])
        const { width, height, data } = withFace
        let minX = width,
          minY = height,
          maxX = -1,
          maxY = -1,
          count = 0
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4
            if ([0, 1, 2].every((channel) => Math.abs(data[offset + channel] - body.data[offset + channel]) < 18)) continue
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
            count++
          }
        }
        return { minX, minY, maxX, maxY, count }
      },
      [first, second].map((png) => png.toString('base64'))
    )
  await facing.selectOption('left')
  const frames = []
  let neutralBody
  for (const index of [0, 1, 2, 3]) {
    await frame.selectOption(String(index))
    await draw(0)
    expect(await readOrder()).toBe(`F${index} · baseBody → face`)
    const full = await captureActor(`face-01-frame-${index}`)
    await face.uncheck()
    await draw(0)
    const body = await captureActor(index === 0 ? 'face-01-body' : undefined)
    if (index === 0) neutralBody = body
    expect(await readOrder()).toBe(`F${index} · baseBody`)
    frames.push(await difference(full, body))
    await face.check()
  }
  expect(frames.every(({ count }) => count > 85)).toBe(true)
  expect(Math.abs(frames[2].minY - frames[0].minY + 3 * 0.3125 * camera.scale)).toBeLessThan(1.1)
  await frame.selectOption('0')
  await facing.selectOption('right')
  await draw(0)
  const rightFace = await captureActor('face-01-right')
  await face.uncheck()
  await draw(0)
  const right = await difference(rightFace, await captureActor())
  await face.check()
  const pivot = footX - clip.x - 0.5
  const residual = {
    x: [right.maxX + frames[0].minX - 2 * pivot, right.minX + frames[0].maxX - 2 * pivot],
    y: [right.minY - frames[0].minY, right.maxY - frames[0].maxY],
  }
  expect(residual.x.every((value) => Math.abs(value) <= 2)).toBe(true)
  expect(residual.y.every((value) => Math.abs(value) <= 1)).toBe(true)
  await writeFile(
    testInfo.outputPath('face-mirror-raster.json'),
    JSON.stringify({ cameraScale: camera.scale, pivot, frames, right, residual }, null, 2) + '\n'
  )
  await facing.selectOption('left')
  await xSlider.fill('10.5')
  await ySlider.fill('-6')
  await draw(0)
  const translated = await difference(await captureActor(), neutralBody)
  expect(Math.abs(translated.minX - frames[0].minX - 10.5 * 0.3125 * camera.scale)).toBeLessThan(1.5)
  expect(Math.abs(translated.minY - frames[0].minY + 6 * 0.3125 * camera.scale)).toBeLessThan(1.5)
  await page.getByRole('slider', { name: '等比縮放' }).fill('1.2')
  await page.getByRole('button', { name: '複製校正 JSON' }).click()
  await expect.poll(() => page.evaluate(() => globalThis.navigator.clipboard.readText())).toBe('{"xPx":10.5,"yPx":-6,"scale":1.2}')
  await face.uncheck()
  await draw(0)
  expect((await captureActor()).equals(neutralBody)).toBe(true)
  await face.check()
  await page.getByRole('button', { name: '重置校正' }).click()
  await expect(xSlider).toHaveValue('5.5')
  await expect(ySlider).toHaveValue('27.5')
  await expect(scaleSlider).toHaveValue('1.3')
  await draw(0)
  await capture(page, testInfo, 'face-01-desktop')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await draw(14)
  expect(await readOrder()).toBe('F1 · baseBody → face')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await draw(30)
  expect(await readOrder()).toBe('F1 · baseBody → face')
  await page.getByLabel('播放速度').selectOption('2')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await draw(3)
  expect(await readOrder()).toBe('F2 · baseBody → face')
  await page.getByRole('button', { name: '卸載場景' }).click()
  await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
})

test('uses real gameplay touch in landscape and samples the live WebGL render loop', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 667, height: 375 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  try {
    const page = await context.newPage()
    await installAtlasAudit(page, atlasDimensions)
    await page.goto(previewUrl)
    await expect(mapLabel(page)).toHaveText('Village')
    await previewButton(page).tap()
    await page.getByLabel('角色素材').selectOption('paper-doll')
    await expectCharacterTextures(page, undefined, 3)
    await previewButton(page).tap()
    const touch = await context.newCDPSession(page)
    const right = page.getByRole('button', { name: '向右', exact: true })
    const portal = page.getByRole('button', { name: '進入傳送門' })
    const portalHint = page.getByText('按 ↑／W 或點觸控 ↑ 進入傳送門')
    await right.scrollIntoViewIfNeeded()
    const { x, y, width, height } = await right.boundingBox()
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + width / 2, y: y + height / 2 }] })
    await expect.poll(() => portalHint.isVisible(), { intervals: [20] }).toBe(true)
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const portalBounds = await portal.boundingBox()
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: portalBounds.x + portalBounds.width / 2, y: portalBounds.y + portalBounds.height / 2 }],
    })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(mapLabel(page)).toHaveText('Forest Entrance')
    await expectCharacterTextures(page, undefined, 3)
    await expect(page.locator('.playground-canvas')).toHaveAttribute('data-parallax-textures', '4')
    await expect(hud(page)).toContainText('待機')
    const map = mapById.get('m1')
    const { position } = map.spawns.find(({ id }) => id === 'spawn_from_village')
    expect(await avatarPixels(page, map, position, [position])).toEqual([true])
    await capture(page, testInfo, 'face-01-mobile')
    await previewButton(page).tap()
    await page.getByLabel('角色高度').selectOption('80')
    await page.getByLabel('腳底錨點').tap()
    await capture(page, testInfo, 'mobile-controls')
    await page.getByLabel('角色高度').selectOption('90')
    await page.getByLabel('腳底錨點').tap()
    await previewButton(page).tap()
    await page.getByRole('button', { name: '跳躍' }).tap()
    await expect(hud(page)).toContainText('跳躍')
    await expect(hud(page)).toContainText('待機')
    await recordLiveFps(page, browser, testInfo, 'mobile-d3d11')
  } finally {
    await context.close()
  }
})

test('renders local and interpolated remote Paper Dolls in the same room using shared atlases per canvas', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const fixture = await startBrowserFixtureServer({ traceMovement: true })
  const peer = await browser.newPage({ baseURL })
  let peerSeat
  const paperDollRequests = []
  page.on('request', (request) => {
    if (/beginner-(?:base-body-idle|face-01)-atlas\./.test(request.url())) paperDollRequests.push(request.url())
  })
  try {
    for (const client of [page, peer]) {
      await installAtlasAudit(client, atlasDimensions)
      await client.route('**/multiplayer/matchmake/joinOrCreate/map', async (route) => {
        const seat = await fixture.reserve(route.request().postDataJSON())
        if (client === peer) peerSeat = seat
        await route.fulfill({ json: seat })
      })
      await client.goto(previewUrl + '&multiplayerDiagnostics=1&appearanceDiagnostics=1')
      await client.getByLabel('場景模式').selectOption('multiplayer')
      await expect(mapLabel(client)).toHaveText('Forest Entrance')
      await previewButton(client).click()
      await client.getByLabel('角色素材').selectOption('paper-doll')
      await expectCharacterTextures(client, undefined, 3)
      await previewButton(client).click()
    }
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 2 人')
    const peerHost = peer.locator('.playground-canvas')
    const readX = () => peerHost.evaluate((element) => Number(element.dataset.localPredictedX))
    const startX = await readX()
    const authority = fixture.startMovementTrace(peerSeat, Date.now())
    await expect.poll(async () => (await appearance(page))?.remote[0]?.renderState).toBe('idle')
    const idle = { predicted: await appearance(peer), observer: await appearance(page) }
    await stage(peer).focus()
    await peer.keyboard.down('ArrowLeft')
    await expect.poll(async () => (await appearance(peer))?.local.renderState).toBe('run')
    await expect.poll(async () => (await appearance(page))?.remote[0]?.renderState).toBe('run')
    const run = { predicted: await appearance(peer), observer: await appearance(page) }
    await expect.poll(readX, { intervals: [50] }).toBeLessThan(startX - 60)
    await peer.keyboard.up('ArrowLeft')
    await expect(hud(peer)).toContainText('待機')
    await page.bringToFront()
    await expect.poll(async () => (await appearance(page))?.remote[0]?.renderState).toBe('idle')
    const released = { predicted: await appearance(peer), observer: await appearance(page) }
    const authoritative = authority
      .stop()
      .events.filter(({ kind }) => kind === 'tick')
      .map(({ serverTick, after }) => ({
        serverTick,
        action: after.action,
        locomotion: after.locomotion,
        moveX: after.moveX,
      }))
    await writeFile(
      testInfo.outputPath('multiplayer-appearance.json'),
      JSON.stringify({ idle, run, released, authoritative }, null, 2) + '\n'
    )
    for (const { predicted, observer } of [idle, run, released]) {
      expect(predicted.local.faceVisible).toBe(true)
      expect(observer.remote[0].faceVisible).toBe(true)
    }
    expect(authoritative).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'none', locomotion: 'run' })]))
    expect(run.predicted.local.pose).toBe('neutral')
    expect(run.observer.remote[0].pose).toBe('neutral')
    const map = mapById.get('m1')
    const { position } = map.spawns.find(({ id }) => id === 'spawn_from_village')
    await expect
      .poll(async () => {
        const remote = await page.locator('.playground-canvas').evaluate((element) => JSON.parse(element.dataset.remoteFrame || 'null'))
        if (!remote || remote.x > position.x - 48) return []
        return avatarPixels(page, map, position, [position, remote])
      })
      .toEqual([true, true])
    await expectCharacterTextures(page, undefined, 3)
    expect(paperDollRequests).toHaveLength(2)
    await capture(page, testInfo, 'face-01-multiplayer')
    await recordLiveFps(page, browser, testInfo, 'desktop-d3d11')
    await peer.getByRole('button', { name: '卸載場景' }).click()
    await expect.poll(() => readAtlasAudit(peer)).toEqual({ bitmaps: [], textures: [] })
    await page.bringToFront()
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 1 人', { timeout: 40000 })
    await expectCharacterTextures(page, undefined, 3)
    expect(paperDollRequests).toHaveLength(2)
    await page.getByRole('button', { name: '卸載場景' }).click()
    await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
  } finally {
    await peer.close()
    await fixture.close()
  }
})
