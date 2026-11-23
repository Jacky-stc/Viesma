import { expect, test } from '@playwright/test'
import { followCamera } from '../../apps/client/src/rendering/camera.ts'
import { bodySize, planGrayboxTour } from '../../packages/simulation/test/graybox-walkthrough.mjs'
import { installAtlasAudit, readAtlasAudit } from './atlas-audit.mjs'
import { installFrameClock } from './frame-clock.mjs'

const portalHint = '按 ↑／W 或點觸控 ↑ 進入傳送門'
const names = {
  village: 'Village',
  m1: 'Forest Entrance',
  m2: 'Eastern Plains',
  m3: 'Rocky Hills',
  m4: 'Underground Cave',
  m5: 'Deep Forest',
  m6: 'Ancient Ruins',
}

async function expectArrivalCamera(canvas, map, arrival, reversePortalId) {
  const { width, height } = await canvas.boundingBox()
  const target = { x: arrival.x + bodySize.width / 2, y: arrival.y + bodySize.height / 2 }
  const { origin, scale } = followCamera(target, map.bounds, { width, height })
  const portal = map.portals.find(({ id }) => id === reversePortalId).bounds
  const png = await canvas.screenshot()
  const positions = {
    gate: {
      x: ((portal.origin.x + portal.width / 2 - origin.x) * scale) / width,
      y: ((portal.origin.y - origin.y) * scale) / height,
    },
    player: {
      x: ((target.x - origin.x) * scale) / width,
      y: ((target.y + 3 - origin.y) * scale) / height,
    },
  }
  const samples = await canvas.evaluate(
    async (_element, { image, positions }) => {
      const response = await globalThis.fetch(`data:image/png;base64,${image}`)
      const bitmap = await globalThis.createImageBitmap(await response.blob())
      const { width, height } = bitmap
      const context = new globalThis.OffscreenCanvas(width, height).getContext('2d')
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      // 驗證抵達門框及 Beginner 的上衣確實畫在目的地鏡頭的預期區域。
      const palette = { gate: [255, 204, 137], player: [255, 188, 103] }
      return Object.fromEntries(
        Object.entries(positions).map(([id, { x, y }]) => {
          const left = Math.round(x * width) - 4
          const top = Math.round(y * height) - 4
          const { data } = context.getImageData(left, top, 9, 9)
          const [red, green, blue] = palette[id]
          return [
            id,
            data.some(
              (value, index) =>
                index % 4 === 0 && Math.abs(value - red) + Math.abs(data[index + 1] - green) + Math.abs(data[index + 2] - blue) < 110
            ),
          ]
        })
      )
    },
    { image: png.toString('base64'), positions }
  )
  expect(samples, map.id + '/' + reversePortalId).toEqual({ gate: true, player: true })
}

test('keyboard visits all twelve directed portals with the same canvas, destination camera and bounded atlas lifetime', async ({
  page,
}, testInfo) => {
  test.setTimeout(Math.max(testInfo.timeout, 90_000))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const draw = await installFrameClock(page)
  await installAtlasAudit(page)
  await page.goto('/')
  const canvas = page.getByRole('img', { name: 'Beginner 平台場景' })
  const currentMap = page.getByLabel('目前地圖')
  await expect(canvas).toBeVisible()
  await draw(0)
  await expect(currentMap).toHaveText('Village')
  await page.getByRole('region', { name: '平台測試場' }).focus()
  const original = await canvas.elementHandle()
  let held = 0

  for (const { portal, approachInputs, map, arrival } of planGrayboxTour()) {
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
    await expect(page.getByText(portalHint)).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await draw(1)
    await expect(currentMap).toHaveText(names[map.id])
    await expect(page.getByText(portalHint)).toBeHidden()
    await expect(canvas).toHaveCount(1)
    expect(await original.evaluate((element) => element.isConnected)).toBe(true)
    await expectArrivalCamera(canvas, map, arrival, portal.reversePortalId)
    const atlases = ['beginner', map.id === 'village' ? 'village' : 'field']
    await expect
      .poll(async () => {
        await draw(0)
        return readAtlasAudit(page)
      })
      .toEqual({ bitmaps: atlases, textures: atlases })
    if (map.id === 'm1' && portal.reversePortalId === 'p_to_village') {
      await canvas.screenshot({ path: testInfo.outputPath('forest-atlases.png') })
    }
  }
  await expect(currentMap).toHaveText('Village')
  await page.getByRole('button', { name: '卸載場景' }).click()
  await expect.poll(() => readAtlasAudit(page)).toEqual({ bitmaps: [], textures: [] })
  expect(errors).toEqual([])
})
