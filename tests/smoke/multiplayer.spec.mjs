import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { clearTimeout, setTimeout } from 'node:timers'
import { joinSmokePeer, startBrowserFixtureServer } from '../../apps/server/test/browser-fixture-server.mjs'

async function routeFixtureRoom(page, fixture) {
  let seat
  await page.route('**/multiplayer/matchmake/joinOrCreate/map', async (route) => {
    seat = await fixture.reserve(route.request().postDataJSON())
    await route.fulfill({ json: seat })
  })
  return () => seat
}

async function gateInputFrames(page, fixtureAddress) {
  const messageName = Buffer.from('InputFrame')
  let blocked = false
  let dropped = 0
  let forwarded = 0
  let closed = false
  let jitter = false
  let incoming = 0
  let delayedBatches = 0
  await page.routeWebSocket(
    ({ host }) => host === fixtureAddress,
    (socket) => {
      const server = socket.connectToServer()
      const pending = []
      let delivery
      function clearDelivery() {
        clearTimeout(delivery)
        pending.length = 0
      }
      socket.onClose((code, reason) => {
        clearDelivery()
        server.close({ code, reason })
      })
      server.onClose((code, reason) => {
        closed = true
        clearDelivery()
        socket.close({ code, reason })
      })
      server.onMessage((message) => {
        if (delivery) pending.push(message)
        else if (jitter && ++incoming % 3 === 1) {
          delayedBatches++
          pending.push(message)
          // Colyseus 的 delta 與其後 checkpoint 保持原本順序。
          delivery = setTimeout(() => {
            for (const queued of pending) socket.send(queued)
            pending.length = 0
            delivery = undefined
          }, 45)
        } else socket.send(message)
      })
      socket.onMessage((message) => {
        if (Buffer.isBuffer(message) && message.includes(messageName)) {
          if (blocked) {
            dropped++
            return
          }
          forwarded++
        }
        server.send(message)
      })
    }
  )
  return {
    dropped: () => dropped,
    closed: () => closed,
    delayedBatches: () => delayedBatches,
    jitter(enabled) {
      jitter = enabled
    },
    block() {
      blocked = true
      return forwarded
    },
    unblock() {
      blocked = false
    },
  }
}

test('plays multiplayer by default without diagnostic DOM writes during patches or cleanup', async ({ page, baseURL }) => {
  const diagnosticAttributes = [
    'data-prediction-ack',
    'data-prediction-replayed',
    'data-prediction-correction',
    'data-prediction-correction-mode',
    'data-prediction-overflows',
    'data-remote-snapshot-tick',
    'data-remote-authority-x',
    'data-shared-monsters',
    'data-remote-frame',
    'data-monster-sprites',
    'data-peer-sprites',
  ]
  let checkpoints = 0
  const checkpointMessage = Buffer.from('MovementCheckpoint')
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (Buffer.isBuffer(payload) && payload.includes(checkpointMessage)) checkpoints++
    })
  })
  await page.addInitScript((attributes) => {
    const { document, MutationObserver } = globalThis
    const writes = []
    const observer = new MutationObserver((records) => {
      for (const { attributeName, target } of records) {
        if (target.classList.contains('playground-canvas')) writes.push(attributeName)
      }
    })
    observer.observe(document, { attributes: true, attributeFilter: attributes, subtree: true })
    globalThis.diagnosticWrites = writes
  }, diagnosticAttributes)
  const scene = page.locator('.playground-canvas')
  const readDiagnostics = () =>
    scene.evaluate((host, names) => host.getAttributeNames().filter((name) => names.includes(name)), diagnosticAttributes)
  await page.goto('/')
  await page.getByLabel('場景模式').selectOption('multiplayer')
  await expect(page.getByLabel('目前地圖')).toHaveText('Forest Entrance')
  const peer = await joinSmokePeer(baseURL)
  try {
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 2 人')
    await page.bringToFront()
    await page.getByRole('region', { name: '平台測試場' }).focus()
    const before = checkpoints
    await page.keyboard.down('ArrowRight')
    await expect(page.getByLabel('Beginner 狀態')).toContainText('跑步 · 朝右')
    await expect.poll(() => checkpoints).toBeGreaterThanOrEqual(before + 3)
    await page.keyboard.up('ArrowRight')
    await expect(page.getByLabel('Beginner 狀態')).toContainText('待機')
    expect(await readDiagnostics()).toEqual([])

    await page.getByRole('button', { name: '卸載場景' }).click()
    await expect(page.getByRole('img', { name: 'Beginner 平台場景' })).toHaveCount(0)
    await expect.poll(() => peer.state.players.size).toBe(1)
    expect(await readDiagnostics()).toEqual([])
    expect(await page.evaluate(() => globalThis.diagnosticWrites)).toEqual([])
  } finally {
    await peer.leave()
  }
})

test('two M1 browsers predict keyboard and touch before delivery and reconcile a large server correction', async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow()
  const other = await browser.newPage({ baseURL, viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })
  const fixture = await startBrowserFixtureServer()
  try {
    const errors = []
    const keyboardSeat = await routeFixtureRoom(page, fixture)
    const touchSeat = await routeFixtureRoom(other, fixture)
    const keyboard = await gateInputFrames(page, fixture.address)
    const touchInput = await gateInputFrames(other, fixture.address)
    const canvas = page.getByRole('img', { name: 'Beginner 平台場景' })
    const scene = (client) => client.locator('.playground-canvas')
    const ack = (seat) => fixture.ownerAck(seat()) ?? 0
    for (const client of [page, other]) {
      client.on('pageerror', (error) => errors.push(error.message))
      await client.goto('/?multiplayerDiagnostics=1')
    }
    for (const client of [page, other]) {
      await client.getByLabel('場景模式').selectOption('multiplayer')
      await expect(client.getByLabel('目前地圖')).toHaveText('Forest Entrance', { timeout: 15000 })
      await expect(client.getByRole('img', { name: 'Beginner 平台場景' })).toHaveCount(1)
      await expect(scene(client)).not.toHaveAttribute('data-prediction-ack')
    }
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 2 人')
    await expect(other.getByLabel('同房角色數')).toHaveText('同房 2 人')

    await page.bringToFront()
    await page.getByRole('region', { name: '平台測試場' }).focus()
    const keyboardBoundary = keyboard.block()
    await page.keyboard.down('ArrowRight')
    await expect(page.getByLabel('Beginner 狀態')).toContainText('跑步 · 朝右')
    await expect.poll(keyboard.dropped).toBeGreaterThanOrEqual(16)
    expect(ack(keyboardSeat)).toBeLessThanOrEqual(keyboardBoundary)
    await expect(other.getByLabel('Beginner 狀態')).toContainText('待機')
    await page.keyboard.up('ArrowRight')
    await expect(page.getByLabel('Beginner 狀態')).toContainText('待機')
    keyboard.unblock()
    await expect.poll(async () => Number(await scene(page).getAttribute('data-prediction-correction'))).toBeGreaterThan(64)
    await expect(scene(page)).toHaveAttribute('data-prediction-correction-mode', 'snap')
    await expect.poll(() => ack(keyboardSeat)).toBeGreaterThan(keyboardBoundary)

    await other.bringToFront()
    const touch = await other.context().newCDPSession(other)
    const left = other.getByRole('button', { name: '向左' })
    await expect(left).toBeVisible()
    const { x, y, width, height } = await left.boundingBox()
    const touchBoundary = touchInput.block()
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + width / 2, y: y + height / 2 }] })
    await expect(other.getByLabel('Beginner 狀態')).toContainText('跑步 · 朝左')
    await expect.poll(touchInput.dropped).toBeGreaterThan(0)
    expect(ack(touchSeat)).toBeLessThanOrEqual(touchBoundary)
    touchInput.unblock()
    await expect.poll(() => ack(touchSeat)).toBeGreaterThan(touchBoundary)
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(other.getByLabel('Beginner 狀態')).toContainText('待機')

    await page.bringToFront()
    const withPeer = await canvas.screenshot()
    await other.getByRole('button', { name: '卸載場景' }).click()
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 1 人')
    await expect.poll(async () => (await canvas.screenshot()).equals(withPeer)).toBe(false)
    await expect(other.getByRole('img', { name: 'Beginner 平台場景' })).toHaveCount(0)
    await expect(canvas).toHaveCount(1)
    await page.getByRole('button', { name: '卸載場景' }).click()
    await expect(canvas).toHaveCount(0)
    await expect.poll(keyboard.closed).toBe(true)
    await expect.poll(touchInput.closed).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await other.close()
    await fixture.close()
  }
})

test('interpolates under patch jitter and synchronizes the shared monster through rejoin, HP and removal', async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow()
  const mover = await browser.newPage({ baseURL })
  const fixture = await startBrowserFixtureServer()
  const errors = []
  const scene = (client) => client.locator('.playground-canvas')
  const canvas = (client) => client.getByRole('img', { name: 'Beginner 平台場景' })
  const projection = (client) =>
    scene(client).evaluate(({ dataset }) => ({ tick: Number(dataset.remoteSnapshotTick), monsters: JSON.parse(dataset.sharedMonsters) }))
  try {
    const network = await gateInputFrames(page, fixture.address)
    for (const client of [page, mover]) {
      await routeFixtureRoom(client, fixture)
      client.on('pageerror', (error) => errors.push(error.message))
      await client.goto('/?multiplayerDiagnostics=1')
    }
    for (const client of [page, mover]) {
      await client.getByLabel('場景模式').selectOption('multiplayer')
      await expect(client.getByLabel('目前地圖')).toHaveText('Forest Entrance', { timeout: 15000 })
      await expect(canvas(client)).toHaveCount(1)
    }
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 2 人')
    await expect(mover.getByLabel('同房角色數')).toHaveText('同房 2 人')
    const [slime] = (await projection(page)).monsters
    expect(slime).toMatchObject({ archetypeId: 'slime', hp: 71, maxHp: 71, y: 896 })
    for (const client of [page, mover]) await expect(scene(client)).toHaveAttribute('data-monster-sprites', slime.monsterId)
    await expect(scene(page)).toHaveAttribute('data-peer-sprites', '1')
    const history = (client) =>
      scene(client).evaluate(
        (host) =>
          new Promise((resolve) => {
            const snapshots = new Map()
            const view = host.ownerDocument.defaultView
            function collect() {
              const { remoteSnapshotTick, sharedMonsters } = host.dataset
              snapshots.set(Number(remoteSnapshotTick), JSON.parse(sharedMonsters))
              if (snapshots.size >= 8) {
                observer.disconnect()
                resolve([...snapshots])
              }
            }
            const observer = new view.MutationObserver(collect)
            observer.observe(host, { attributes: true, attributeFilter: ['data-remote-snapshot-tick'] })
            collect()
          })
      )
    const [first, second] = (await Promise.all([history(page), history(mover)])).map((snapshots) => new Map(snapshots))
    const commonTicks = [...first.keys()].filter((tick) => second.has(tick))
    expect(commonTicks.length).toBeGreaterThanOrEqual(3)
    for (const tick of commonTicks) expect(first.get(tick)).toEqual(second.get(tick))

    network.jitter(true)
    await mover.bringToFront()
    await mover.getByRole('region', { name: '平台測試場' }).focus()
    await mover.keyboard.down('ArrowRight')
    const samples = await scene(page).evaluate(
      (host) =>
        new Promise((resolve) => {
          const result = []
          const view = host.ownerDocument.defaultView
          let start
          function collect(now) {
            start ??= now
            const { remoteFrame, remoteSnapshotTick, remoteAuthorityX } = host.dataset
            if (remoteFrame) {
              result.push({ ...JSON.parse(remoteFrame), snapshotTick: Number(remoteSnapshotTick), authorityX: Number(remoteAuthorityX) })
            }
            if (now - start < 1650) view.requestAnimationFrame(collect)
            else resolve(result)
          }
          view.requestAnimationFrame(collect)
        })
    )
    await mover.keyboard.up('ArrowRight')
    network.jitter(false)
    expect(network.delayedBatches()).toBeGreaterThanOrEqual(3)
    const interpolated = samples.filter(
      ({ mode, tick, snapshotTick, x, authorityX }) => mode === 'interpolate' && tick < snapshotTick && authorityX - x > 1
    )
    expect(new Set(interpolated.map(({ snapshotTick }) => snapshotTick)).size, JSON.stringify(samples)).toBeGreaterThanOrEqual(3)
    expect(interpolated.at(-1).x - interpolated[0].x).toBeGreaterThan(100)

    await mover.getByRole('button', { name: '卸載場景' }).click()
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 1 人')
    await expect(scene(page)).toHaveAttribute('data-remote-frame', '')
    await expect(scene(page)).toHaveAttribute('data-peer-sprites', '0')
    await expect(scene(page)).toHaveAttribute('data-monster-sprites', slime.monsterId)
    await expect(canvas(mover)).toHaveCount(0)
    await mover.getByRole('button', { name: '載入場景' }).click()
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 2 人')
    await expect(scene(page)).toHaveAttribute('data-peer-sprites', '1')
    await expect(scene(mover)).toHaveAttribute('data-monster-sprites', slime.monsterId)
    expect((await projection(mover)).monsters[0]).toMatchObject({ monsterId: slime.monsterId, hp: slime.hp })

    expect(fixture.queueFixtureEvent('test-hp')).toBe(true)
    expect(fixture.queueFixtureEvent('test-hp')).toBe(false)
    for (const client of [page, mover]) {
      await expect.poll(async () => (await projection(client)).monsters[0]).toMatchObject({ monsterId: slime.monsterId, hp: 35 })
      await expect(scene(client)).toHaveAttribute('data-monster-sprites', slime.monsterId)
    }
    expect(fixture.queueFixtureEvent('remove')).toBe(true)
    expect(fixture.queueFixtureEvent('remove')).toBe(false)
    for (const client of [page, mover]) {
      await expect.poll(async () => (await projection(client)).monsters).toEqual([])
      await expect(scene(client)).toHaveAttribute('data-monster-sprites', '')
      await expect(canvas(client)).toHaveCount(1)
    }
    expect(errors).toEqual([])
  } finally {
    await mover.close()
    await fixture.close()
  }
})
