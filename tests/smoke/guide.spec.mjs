import { expect, test } from '@playwright/test'
import { followCamera } from '../../apps/client/src/rendering/camera.ts'
import { bodySize, graybox, mapById } from '../../packages/simulation/test/graybox-walkthrough.mjs'
import { installFrameClock } from './frame-clock.mjs'

const scene = (page) => page.getByRole('region', { name: '平台測試場' })
const canvas = (page) => page.getByRole('img', { name: 'Beginner 平台場景' })
const dialogue = (page) => page.getByRole('dialog', { name: 'Guide' })
const guideHint = (page) => page.getByText('按 E 或點觸控「互動」與 Guide 對話')
const portalHint = (page) => page.getByText('按 ↑／W 或點觸控 ↑ 進入傳送門')
const currentMap = (page) => page.getByLabel('目前地圖')

function recordErrors(page) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

async function guidePixelIsVisible(world) {
  const map = mapById.get(graybox.guide.mapId)
  const spawn = map.spawns.find(({ id }) => id === graybox.world.respawn.spawnId)
  const { position } = graybox.guide.npc
  const { width, height } = await world.boundingBox()
  const target = { x: spawn.position.x + bodySize.width / 2, y: spawn.position.y + bodySize.height / 2 }
  const { origin, scale } = followCamera(target, map.bounds, { width, height })
  const png = await world.screenshot()
  return world.evaluate(
    async (_element, { image, x, y }) => {
      const response = await globalThis.fetch(`data:image/png;base64,${image}`)
      const bitmap = await globalThis.createImageBitmap(await response.blob())
      const context = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
      context.drawImage(bitmap, 0, 0)
      const [red, green, blue] = context.getImageData(Math.round(x * bitmap.width), Math.round(y * bitmap.height), 1, 1).data
      bitmap.close()
      return Math.abs(red - 88) + Math.abs(green - 153) + Math.abs(blue - 133) < 30
    },
    { image: png.toString('base64'), x: ((position.x - origin.x) * scale) / width, y: ((position.y - 10 - origin.y) * scale) / height }
  )
}

test('desktop shows the Tiled Guide and explicitly opens and closes its dialogue with game focus', async ({ page }, testInfo) => {
  const errors = recordErrors(page)
  const draw = await installFrameClock(page)
  await page.goto('/')
  const world = canvas(page)
  await expect(world).toBeVisible()
  await draw(0)
  await expect(currentMap(page)).toHaveText('Village')
  const original = await world.elementHandle()
  await expect
    .poll(async () => {
      await draw(0)
      return guidePixelIsVisible(world)
    })
    .toBe(true)

  await scene(page).focus()
  await page.keyboard.press('KeyE')
  await draw(1)
  await expect(dialogue(page)).toBeHidden()
  await page.keyboard.down('ArrowRight')
  await draw(7)
  await page.keyboard.up('ArrowRight')
  await draw(7)
  await expect(guideHint(page)).toBeVisible()
  await expect(dialogue(page)).toBeHidden()
  await page.keyboard.press('KeyW')
  await draw(1)
  await expect(dialogue(page)).toBeHidden()
  await expect(currentMap(page)).toHaveText('Village')

  await page.getByRole('combobox', { name: '場景模式' }).focus()
  await page.keyboard.press('KeyE')
  await draw(1)
  await expect(dialogue(page)).toBeHidden()
  await scene(page).focus()
  await page.keyboard.down('KeyE')
  await draw(1)
  await expect(dialogue(page)).toBeVisible()
  await expect(dialogue(page).getByRole('listitem')).toHaveCount(5)
  await page.keyboard.down('KeyE')
  await draw(4)
  await page.keyboard.up('KeyE')
  await expect(dialogue(page)).toHaveCount(1)
  await scene(page).screenshot({ path: testInfo.outputPath('desktop-guide.png') })

  const close = dialogue(page).getByRole('button', { name: '關閉' })
  await close.focus()
  await page.keyboard.press('KeyE')
  await page.keyboard.press('KeyJ')
  await draw(2)
  await expect(dialogue(page)).toBeVisible()
  await expect(page.getByLabel('Beginner 狀態')).toContainText('待機')
  await page.keyboard.press('Enter')
  await draw(1)
  await expect(dialogue(page)).toBeHidden()
  await expect(scene(page)).toBeFocused()
  await page.keyboard.press('KeyE')
  await draw(1)
  await expect(dialogue(page)).toBeVisible()
  await page.keyboard.press('KeyE')
  await draw(1)
  await expect(dialogue(page)).toBeHidden()

  await page.keyboard.down('ArrowRight')
  for (let step = 0; step < 40 && !(await portalHint(page).isVisible()); step++) await draw(4)
  await page.keyboard.up('ArrowRight')
  await draw(4)
  await expect(portalHint(page)).toBeVisible()
  await expect(currentMap(page)).toHaveText('Village')
  await page.keyboard.press('KeyE')
  await draw(1)
  await expect(currentMap(page)).toHaveText('Village')
  await expect(dialogue(page)).toBeHidden()
  await page.keyboard.press('KeyW')
  await draw(1)
  await expect(currentMap(page)).toHaveText('Forest Entrance')
  await expect(dialogue(page)).toBeHidden()
  await expect(world).toHaveCount(1)
  expect(await original.evaluate((element) => element.isConnected)).toBe(true)
  expect(errors).toEqual([])
})

test.describe('667 × 375 landscape Guide controls', () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })

  test('touch opens, toggles and closes dialogue without obscuring gameplay controls', async ({ page, context }, testInfo) => {
    const errors = recordErrors(page)
    const draw = await installFrameClock(page)
    await page.goto('/')
    const world = canvas(page)
    await expect(world).toBeVisible()
    await draw(0)
    await expect(currentMap(page)).toHaveText('Village')
    const original = await world.elementHandle()
    const controls = page.getByRole('group', { name: '觸控操作' })
    const interact = controls.getByRole('button', { name: '互動' })
    await interact.tap()
    await draw(1)
    await expect(dialogue(page)).toBeHidden()

    const { x, y, width, height } = await controls.getByRole('button', { name: '向右' }).boundingBox()
    const session = await context.newCDPSession(page)
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + width / 2, y: y + height / 2 }] })
    await draw(7)
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await draw(7)
    await expect(guideHint(page)).toBeVisible()
    await expect(dialogue(page)).toBeHidden()

    await interact.tap()
    await draw(1)
    await expect(dialogue(page)).toBeVisible()
    const close = dialogue(page).getByRole('button', { name: '關閉' })
    expect((await close.boundingBox()).height).toBeGreaterThanOrEqual(44)
    const lesson = dialogue(page).getByRole('list', { name: 'Guide 教學' })
    expect(await lesson.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('mobile-guide.png') })
    await interact.tap()
    await draw(1)
    await expect(dialogue(page)).toBeHidden()
    await interact.tap()
    await draw(1)
    await close.tap()
    await draw(1)
    await expect(dialogue(page)).toBeHidden()
    await expect(currentMap(page)).toHaveText('Village')
    await expect(world).toHaveCount(1)
    expect(await original.evaluate((element) => element.isConnected)).toBe(true)
    expect(errors).toEqual([])
  })
})
