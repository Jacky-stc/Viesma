import { expect, test } from '@playwright/test'
import { installFrameClock, waitForBrowserFrame } from './frame-clock.mjs'

const hud = (page) => page.getByLabel('Beginner 狀態')
const scene = (page) => page.getByRole('region', { name: '平台測試場' })
const currentMap = (page) => page.getByLabel('目前地圖')
const portalHint = (page) => page.getByText('按 ↑／W 或點觸控 ↑ 進入傳送門')
const canvas = (page) => page.getByRole('img', { name: 'Beginner 平台場景' })

async function drawUntilPortal(page, draw) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await draw(4)
    if (await portalHint(page).isVisible()) return
  }
  throw new Error('Player did not reach a portal within 200 movement ticks')
}

test('desktop keyboard moves and jumps only with game focus, and clears held keys on interruption', async ({ page }) => {
  const draw = await installFrameClock(page)
  await page.goto('/')
  await expect(canvas(page)).toBeVisible()
  await draw(0)
  await expect(hud(page)).toContainText('互動操作 · 待機 · 朝右')
  const mode = page.getByRole('combobox', { name: '場景模式' })
  await mode.focus()
  await page.keyboard.press('KeyJ')
  await draw(2)
  await expect(hud(page)).toContainText('互動操作 · 待機 · 朝右')

  await page.getByRole('img', { name: 'Beginner 平台場景' }).click()
  await expect(scene(page)).toBeFocused()
  await page.keyboard.down('ArrowLeft')
  await draw(2)
  await expect(hud(page)).toContainText('跑步 · 朝左')
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('blur')))
  await draw(4)
  await expect(hud(page)).toContainText('待機 · 朝左')
  await page.keyboard.down('ArrowLeft')
  await draw(2)
  await expect(hud(page)).toContainText('待機 · 朝左')
  await page.keyboard.up('ArrowLeft')

  await page.keyboard.down('Space')
  await draw(2)
  await expect(hud(page)).toContainText('跳躍 · 朝左')
  await draw(22)
  await expect(hud(page)).toContainText('待機 · 朝左')
  await page.keyboard.up('Space')
  await page.keyboard.press('KeyJ')
  await draw(2)
  await expect(hud(page)).toContainText('攻擊 · 朝左')
  await draw(15)
  await expect(hud(page)).toContainText('待機 · 朝左')
  await page.keyboard.press('KeyE')
  await draw(2)
  await expect(hud(page)).toContainText('輸入 · 互動')

  await page.keyboard.down('KeyD')
  await draw(2)
  await expect(hud(page)).toContainText('跑步 · 朝右')
  await page.getByRole('button', { name: '操作說明' }).click()
  const dialog = page.getByRole('dialog', { name: '操作說明' })
  await expect(dialog).toBeVisible()
  await draw(4)
  await expect(hud(page)).toContainText('待機 · 朝右')
  await dialog.evaluate((element) => element.append(element.ownerDocument.createElement('input')))
  const input = dialog.getByRole('textbox')
  await input.focus()
  await page.keyboard.type('aj ef12')
  await expect(input).toHaveValue('aj ef12')
  await expect(hud(page)).toContainText('待機 · 朝右')
  await expect(hud(page)).toContainText('輸入 · 互動')
  await page.keyboard.up('KeyD')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await scene(page).focus()
  await page.keyboard.press('KeyK')
  await draw(2)
  await expect(hud(page)).toContainText('輸入 · 能力點數')
})

test('keyboard walks both maps and activates a portal only on a fresh Up press', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const draw = await installFrameClock(page)
  await page.goto('/')
  const world = canvas(page)
  await expect(world).toBeVisible()
  await draw(0)
  await expect(currentMap(page)).toHaveText('Village')
  await scene(page).focus()
  const originalCanvas = await world.elementHandle()
  async function portalScreenX() {
    const png = await world.screenshot()
    return page.evaluate(async (image) => {
      const response = await globalThis.fetch(`data:image/png;base64,${image}`)
      const bitmap = await globalThis.createImageBitmap(await response.blob())
      const { width, height } = bitmap
      const context = new globalThis.OffscreenCanvas(width, height).getContext('2d')
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const { data } = context.getImageData(0, 0, width, height)
      let sum = 0
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        // 傳送門外框為金色。比較同一個地圖物件在相機追蹤前後的畫布位置。
        const x = (i / 4) % width
        if (x > width * 0.4 && data[i] === 255 && data[i + 1] === 204 && data[i + 2] === 137) {
          sum += x
          count++
        }
      }
      return count === 0 ? null : sum / count / width
    }, png.toString('base64'))
  }
  const initialPortalX = await portalScreenX()
  expect(initialPortalX).toBeGreaterThan(0.7)

  await page.keyboard.down('ArrowUp')
  await draw(1)
  await page.keyboard.down('ArrowRight')
  await drawUntilPortal(page, draw)
  await page.keyboard.up('ArrowRight')
  await draw(4)
  await expect(hud(page)).toContainText('待機')
  await expect(portalHint(page)).toBeVisible()
  await expect(currentMap(page)).toHaveText('Village')
  expect(await portalScreenX()).toBeLessThan(initialPortalX - 0.2)
  await page.keyboard.up('ArrowUp')
  await page.keyboard.down('ArrowUp')
  await draw(1)
  await expect(currentMap(page)).toHaveText('Forest Entrance')

  await page.keyboard.down('ArrowLeft')
  await drawUntilPortal(page, draw)
  await page.keyboard.up('ArrowLeft')
  await draw(4)
  await expect(hud(page)).toContainText('待機 · 朝左')
  await expect(portalHint(page)).toBeVisible()
  await page.keyboard.press('KeyW')
  await draw(1)
  await expect(currentMap(page)).toHaveText('Forest Entrance')
  await page.keyboard.up('ArrowUp')
  await page.keyboard.press('KeyW')
  await draw(1)
  await expect(currentMap(page)).toHaveText('Village')
  await page.keyboard.press('Space')
  await draw(2)
  await expect(hud(page)).toContainText('跳躍')
  await draw(22)
  await expect(hud(page)).toContainText('待機')
  await expect(world).toHaveCount(1)
  expect(await originalCanvas.evaluate((element) => element.isConnected)).toBe(true)
  expect(errors).toEqual([])
})

test.describe('667 × 375 landscape touch input', () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })

  test('uses touch to walk between Village, Forest Entrance and Eastern Plains', async ({ page, context }) => {
    const draw = await installFrameClock(page)
    await page.goto('/')
    await expect(canvas(page)).toBeVisible()
    await draw(0)
    await expect(currentMap(page)).toHaveText('Village')
    const group = page.getByRole('group', { name: '觸控操作' })
    const portal = group.getByRole('button', { name: '進入傳送門' })
    const originalCanvas = await canvas(page).elementHandle()
    const session = await context.newCDPSession(page)

    async function walkToPortal(direction) {
      const { x, y, width, height } = await group.getByRole('button', { name: direction }).boundingBox()
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + width / 2, y: y + height / 2 }] })
      await drawUntilPortal(page, draw)
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await draw(4)
      await expect(hud(page)).toContainText('待機')
      await expect(portalHint(page)).toBeVisible()
    }

    for (const destination of ['Forest Entrance', 'Eastern Plains']) {
      await walkToPortal('向右')
      await expect(currentMap(page)).toHaveText('Village')
      await portal.tap()
      await draw(1)
      await expect(currentMap(page)).toHaveText(destination)
      await walkToPortal('向左')
      await portal.tap()
      await draw(1)
      await expect(currentMap(page)).toHaveText('Village')
    }
    expect(await originalCanvas.evaluate((element) => element.isConnected)).toBe(true)
    await expect(page.locator('canvas')).toHaveCount(1)
  })

  test('supports movement with jump and attack, releases cancelled pointers and survives rotation', async ({ page, context }) => {
    const draw = await installFrameClock(page)
    await page.goto('/')
    await expect(canvas(page)).toBeVisible()
    await draw(0)
    await expect(hud(page)).toContainText('互動操作 · 待機 · 朝右')
    const group = page.getByRole('group', { name: '觸控操作' })
    await expect(group.getByRole('button')).toHaveCount(9)
    const session = await context.newCDPSession(page)
    const touch = (type, touchPoints = []) => session.send('Input.dispatchTouchEvent', { type, touchPoints })
    async function point(name, id, viewport = { width: 667, height: 375 }) {
      const box = await group.getByRole('button', { name, exact: true }).boundingBox()
      expect(box).not.toBeNull()
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
      return { id, x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }

    const right = await point('向右', 1)
    const jump = await point('跳躍', 2)
    await touch('touchStart', [right])
    await draw(2)
    await expect(hud(page)).toContainText('跑步 · 朝右')
    await touch('touchStart', [right, jump])
    await draw(2)
    await expect(hud(page)).toContainText('跳躍 · 朝右')
    await touch('touchCancel')
    await draw(22)
    await expect(hud(page)).toContainText('待機 · 朝右')

    const rightButton = group.getByRole('button', { name: '向右', exact: true })
    await rightButton.evaluate((button) => {
      button.addEventListener('pointerdown', (event) => (button.dataset.testPointer = event.pointerId), { once: true })
    })
    await touch('touchStart', [right])
    await draw(2)
    await expect(hud(page)).toContainText('跑步 · 朝右')
    await rightButton.evaluate((button) => button.releasePointerCapture(Number(button.dataset.testPointer)))
    await touch('touchMove', [{ ...right, x: right.x + 30, y: right.y - 30 }])
    await draw(4)
    await expect(hud(page)).toContainText('待機 · 朝右')
    await touch('touchEnd')

    const left = await point('向左', 3)
    const attack = await point('攻擊', 4)
    await touch('touchStart', [left, attack])
    await draw(2)
    await expect(hud(page)).toContainText('攻擊 · 朝左')
    await expect
      .poll(async () => {
        await draw(4)
        return hud(page).textContent()
      })
      .toContain('跑步 · 朝左')
    await touch('touchEnd')
    await draw(4)
    await expect(hud(page)).toContainText('待機 · 朝左')

    await group.getByRole('button', { name: 'HP 藥水' }).tap()
    await draw(2)
    await expect(hud(page)).toContainText('輸入 · HP 藥水')
    const originalCanvas = await canvas(page).elementHandle()
    await touch('touchStart', [right])
    await draw(3)
    await expect(hud(page)).toContainText('跑步 · 朝右')
    await page.setViewportSize({ width: 375, height: 667 })
    await expect(page.getByText('請將裝置轉為橫向以操作。')).toBeVisible()
    await expect(group).toBeHidden()
    // 瀏覽器會在原生影格回呼前送出媒體查詢的 change 事件。
    await waitForBrowserFrame(page)
    await draw(4)
    await expect(hud(page)).toContainText('待機 · 朝右')
    await touch('touchEnd')
    const resized = { width: 640, height: 360 }
    await page.setViewportSize(resized)
    await expect(group).toBeVisible()
    await expect(page.getByText('請將裝置轉為橫向以操作。')).toBeHidden()
    await waitForBrowserFrame(page)
    expect(await originalCanvas.evaluate((element) => element.isConnected)).toBe(true)
    await touch('touchStart', [await point('向左', 5, resized)])
    await draw(2)
    await expect(hud(page)).toContainText('跑步 · 朝左')
    await touch('touchEnd')
    await draw(4)
    await expect(hud(page)).toContainText('待機 · 朝左')
  })
})
