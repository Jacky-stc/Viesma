import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { performance } from 'node:perf_hooks'
import { clearTimeout, setTimeout } from 'node:timers'
import { URL } from 'node:url'
import { joinSmokePeer, startBrowserFixtureServer } from '../../apps/server/test/browser-fixture-server.mjs'

async function routeFixtureRoom(page, fixture) {
  let seat
  await page.route('**/multiplayer/matchmake/joinOrCreate/map', async (route) => {
    seat = await fixture.reserve(route.request().postDataJSON())
    await route.fulfill({ json: seat })
  })
  return () => seat
}

async function routeFixtureTravel(page, fixture, beforeJoin = () => {}) {
  let seat
  await page.route('**/multiplayer/matchmake/joinById/*', async (route) => {
    await beforeJoin(route.request().postDataJSON())
    const pathname = new URL(route.request().url()).pathname
    const response = await route.fetch({ url: `http://${fixture.address}${pathname.slice('/multiplayer'.length)}` })
    if (!response.ok()) return route.fulfill({ response })
    seat = { ...(await response.json()), publicAddress: fixture.address }
    await route.fulfill({ json: seat })
  })
  return () => seat
}

async function delayRoomTraffic(page, fixtureAddress, oneWayMilliseconds) {
  const upstream = []
  const downstream = []
  await page.routeWebSocket(
    ({ host }) => host === fixtureAddress,
    (socket) => {
      const server = socket.connectToServer()
      const pending = new Set()
      function relay(message, destination, samples) {
        const start = performance.now()
        const timer = setTimeout(() => {
          pending.delete(timer)
          const deliveredAt = performance.now()
          samples.push({ deliveredAt, delay: deliveredAt - start, bytes: Buffer.byteLength(message) })
          destination.send(message)
        }, oneWayMilliseconds)
        pending.add(timer)
      }
      function close(destination, code, reason) {
        for (const timer of pending) clearTimeout(timer)
        pending.clear()
        destination.close({ code, reason })
      }
      socket.onClose((code, reason) => close(server, code, reason))
      server.onClose((code, reason) => close(socket, code, reason))
      socket.onMessage((message) => relay(message, server, upstream))
      server.onMessage((message) => relay(message, socket, downstream))
    }
  )
  return { upstream, downstream }
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b)
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2))
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
    'data-multiplayer-character-id',
    'data-multiplayer-map-epoch',
    'data-multiplayer-scene-revision',
    'data-local-authority-x',
    'data-local-predicted-x',
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

test('plays the two-browser slice at 150 ms RTT through transfer and reconnect', async ({ page, browser, baseURL }) => {
  const traveler = await browser.newPage({ baseURL, viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })
  const fixture = await startBrowserFixtureServer()
  const scene = (client) => client.locator('.playground-canvas')
  const canvas = (client) => client.getByRole('img', { name: 'Beginner 平台場景' })
  const map = (client) => client.getByLabel('目前地圖')
  const count = (client) => client.getByLabel('同房角色數')
  const hud = (client) => client.getByLabel('Beginner 狀態')
  const remote = (client) => scene(client).evaluate(({ dataset }) => (dataset.remoteFrame ? JSON.parse(dataset.remoteFrame) : null))
  const x = async () => Number(await scene(traveler).getAttribute('data-local-authority-x'))
  const predictedX = async () => Number(await scene(traveler).getAttribute('data-local-predicted-x'))
  const errors = []
  const { promise: allowRecovery, resolve: releaseRecovery } = Promise.withResolvers()
  let trips = 0
  let reconnects = 0
  try {
    const observerSeat = await routeFixtureRoom(page, fixture)
    await routeFixtureRoom(traveler, fixture)
    const networks = await Promise.all([page, traveler].map((client) => delayRoomTraffic(client, fixture.address, 75)))
    const destinationSeat = await routeFixtureTravel(traveler, fixture, async ({ ticket }) => {
      if (ticket) trips++
      else {
        reconnects++
        await allowRecovery
      }
    })
    await traveler.addInitScript(() => {
      const { MutationObserver, document } = globalThis
      const revisions = new Map()
      new MutationObserver((records) => {
        for (const { target } of records) {
          const { multiplayerSceneRevision, predictionReplayed, predictionCorrectionMode } = target.dataset
          if (multiplayerSceneRevision && !revisions.has(multiplayerSceneRevision)) {
            revisions.set(multiplayerSceneRevision, [predictionReplayed, predictionCorrectionMode])
          }
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-multiplayer-scene-revision'] })
      globalThis.sceneResets = revisions
    })
    for (const client of [page, traveler]) {
      client.on('pageerror', (error) => errors.push(error.message))
      await client.goto('/?multiplayerDiagnostics=1')
      await client.getByLabel('場景模式').selectOption('multiplayer')
      await expect(map(client)).toHaveText('Forest Entrance')
      await expect(client.getByText('開發用匿名身分 · 進度僅暫存於伺服器記憶體')).toBeVisible()
    }
    await expect(count(page)).toHaveText('同房 2 人')
    await expect(count(traveler)).toHaveText('同房 2 人')
    await expect(scene(traveler)).toHaveAttribute('data-multiplayer-scene-revision', '1')
    const characterId = await scene(traveler).getAttribute('data-multiplayer-character-id')
    const slime = await scene(page).getAttribute('data-monster-sprites')
    expect(characterId).toBeTruthy()
    expect(slime).toBeTruthy()
    await canvas(traveler).evaluate((element) => {
      globalThis.travelCanvas = element
    })
    for (const client of [page, traveler]) {
      await expect
        .poll(() => scene(client).evaluate(({ dataset }) => JSON.parse(dataset.sharedMonsters ?? '[]')))
        .toEqual([expect.objectContaining({ monsterId: slime, hp: 71 })])
      await expect.poll(() => remote(client)).toMatchObject({ y: 848 })
    }

    const finishTickSample = fixture.measureTicks()
    const keyboardStart = await remote(traveler)
    await page.bringToFront()
    await page.getByRole('region', { name: '平台測試場' }).focus()
    await page.keyboard.down('ArrowRight')
    await expect(hud(page)).toContainText('跑步 · 朝右')
    await expect.poll(async () => (await remote(traveler))?.x).toBeGreaterThan(keyboardStart.x + 24)
    await page.keyboard.up('ArrowRight')
    await page.keyboard.press('Space')
    await expect(hud(page)).toContainText('跳躍')
    await expect.poll(async () => (await remote(traveler))?.y).toBeLessThan(keyboardStart.y - 15)
    await expect(hud(page)).toContainText('待機')

    await traveler.bringToFront()
    const touch = await traveler.context().newCDPSession(traveler)
    const touchStart = await remote(page)
    async function pressTouch(name) {
      const button = traveler.getByRole('button', { name })
      await expect(button).toBeInViewport()
      const { x, y, width, height } = await button.boundingBox()
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x + width / 2, y: y + height / 2 }] })
    }
    const releaseTouch = () => touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await pressTouch('向右')
    await expect(hud(traveler)).toContainText('跑步 · 朝右')
    await expect.poll(async () => (await remote(page))?.x).toBeGreaterThan(touchStart.x + 24)
    await releaseTouch()
    await expect(hud(traveler)).toContainText('待機')
    await pressTouch('跳躍')
    await expect(hud(traveler)).toContainText('跳躍')
    await releaseTouch()
    await expect.poll(async () => (await remote(page))?.y).toBeLessThan(touchStart.y - 15)
    await expect(hud(traveler)).toContainText('待機')

    await traveler.getByRole('region', { name: '平台測試場' }).focus()
    await traveler.keyboard.down('ArrowUp')
    await traveler.keyboard.down('ArrowLeft')
    await expect.poll(predictedX, { intervals: [25] }).toBeLessThan(250)
    await traveler.keyboard.up('ArrowLeft')
    await expect(hud(traveler)).toContainText('待機')
    await expect.poll(x).toBeLessThan(256)
    expect(await x()).toBeGreaterThan(136)
    expect(await predictedX()).toBeGreaterThan(136)
    await expect(map(traveler)).toHaveText('Forest Entrance')
    expect(trips).toBe(0)
    await traveler.keyboard.up('ArrowUp')
    await traveler.keyboard.down('KeyW')
    await expect
      .poll(async () => ({
        map: await map(traveler).textContent(),
        status: await traveler.locator('.playground-status').allTextContents(),
        x: await x(),
        trips,
        arrivals: destinationSeat() ? fixture.players(destinationSeat()).length : 0,
        errors,
      }))
      .toMatchObject({ map: 'Village', status: [], x: 1188, trips: 1, arrivals: 1, errors: [] })
    await expect(count(page)).toHaveText('同房 1 人')
    await expect(count(traveler)).toHaveText('同房 1 人')
    await expect(scene(traveler)).toHaveAttribute('data-multiplayer-map-epoch', '1')
    await expect(scene(traveler)).toHaveAttribute('data-remote-frame', '')
    await expect(scene(traveler)).toHaveAttribute('data-peer-sprites', '0')
    await expect(scene(traveler)).toHaveAttribute('data-monster-sprites', '')
    await expect(scene(page)).toHaveAttribute('data-monster-sprites', slime)
    expect(fixture.players(observerSeat())).not.toContain(characterId)
    expect(fixture.players(destinationSeat())).toEqual([characterId])
    expect(trips).toBe(1)
    await traveler.keyboard.up('KeyW')

    const villageSeat = destinationSeat()
    expect(fixture.drop(villageSeat)).toBe(true)
    await expect(traveler.getByRole('status').filter({ hasText: '正在重連' })).toBeVisible()
    expect(fixture.players(villageSeat)).toEqual([characterId])
    releaseRecovery()
    await expect(scene(traveler)).toHaveAttribute('data-multiplayer-scene-revision', '3')
    await expect(scene(traveler)).toHaveAttribute('data-multiplayer-character-id', characterId)
    await expect(scene(traveler)).toHaveAttribute('data-multiplayer-map-epoch', '1')
    await expect(map(traveler)).toHaveText('Village')
    expect(fixture.players(destinationSeat())).toEqual([characterId])
    expect(destinationSeat().roomId).toBe(villageSeat.roomId)
    expect(destinationSeat().sessionId).not.toBe(villageSeat.sessionId)
    expect(reconnects).toBe(1)

    await traveler.keyboard.down('ArrowLeft')
    await expect.poll(predictedX, { intervals: [25] }).toBeLessThan(1148)
    await traveler.keyboard.up('ArrowLeft')
    await expect(hud(traveler)).toContainText('待機')
    await expect.poll(x).toBeLessThan(1152)
    expect(await x()).toBeGreaterThan(1032)
    expect(await predictedX()).toBeGreaterThan(1032)
    await pressTouch('進入傳送門')
    await expect(map(traveler)).toHaveText('Forest Entrance')
    await releaseTouch()
    await expect(count(page)).toHaveText('同房 2 人')
    await expect(count(traveler)).toHaveText('同房 2 人')
    await expect(scene(traveler)).toHaveAttribute('data-multiplayer-scene-revision', '4')
    await expect(scene(traveler)).toHaveAttribute('data-multiplayer-character-id', characterId)
    await expect(scene(traveler)).toHaveAttribute('data-multiplayer-map-epoch', '2')
    await expect(scene(traveler)).toHaveAttribute('data-peer-sprites', '1')
    await expect(scene(traveler)).toHaveAttribute('data-monster-sprites', slime)
    expect(fixture.players(observerSeat()).filter((id) => id === characterId)).toHaveLength(1)
    expect(trips).toBe(2)

    expect(await traveler.evaluate(() => [...globalThis.sceneResets])).toEqual(
      ['1', '2', '3', '4'].map((revision) => [revision, ['0', 'snap']])
    )
    for (const client of [page, traveler]) await expect(canvas(client)).toHaveCount(1)
    expect(await canvas(traveler).evaluate((element) => element === globalThis.travelCanvas)).toBe(true)
    expect(errors).toEqual([])

    const { costs, ticks, catchUpTicks, start } = finishTickSample()
    const seconds = (performance.now() - start) / 1000
    expect(costs.length).toBeGreaterThan(60)
    const traffic = networks.map((network) =>
      Object.fromEntries(
        Object.entries(network).map(([direction, samples]) => {
          const measured = samples.filter(({ deliveredAt }) => deliveredAt >= start)
          expect(measured.length).toBeGreaterThan(60)
          return [
            direction,
            {
              frames: measured.length,
              medianDelayMs: percentile(
                measured.map(({ delay }) => delay),
                0.5
              ),
              payloadKiBPerSecond: Number((measured.reduce((sum, { bytes }) => sum + bytes, 0) / 1024 / seconds).toFixed(2)),
            },
          ]
        })
      )
    )
    console.info(
      '[M3.5]',
      JSON.stringify({
        chromium: browser.version(),
        seconds: Number(seconds.toFixed(2)),
        ticks,
        catchUpTicks,
        singleTickSamples: costs.length,
        tickP95Ms: percentile(costs, 0.95),
        tickP99Ms: percentile(costs, 0.99),
        traffic,
      })
    )
  } finally {
    releaseRecovery()
    await traveler.close()
    await fixture.close()
  }
})

test('recovers from a real M1 void fall and a delayed destination join on the same canvas', async ({ page }) => {
  const fixture = await startBrowserFixtureServer()
  const scene = page.locator('.playground-canvas')
  const canvas = page.getByRole('img', { name: 'Beginner 平台場景' })
  const map = page.getByLabel('目前地圖')
  const hud = page.getByLabel('Beginner 狀態')
  const errors = []
  const greeting = Promise.withResolvers()
  let sourceClosed = false
  let held = false
  try {
    const sourceSeat = await routeFixtureRoom(page, fixture)
    const destinationSeat = await routeFixtureTravel(page, fixture)
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('websocket', (socket) => {
      const url = new URL(socket.url())
      if (url.host === fixture.address && url.pathname.endsWith('/' + sourceSeat()?.roomId)) {
        socket.on('close', () => (sourceClosed = true))
      }
    })
    await page.routeWebSocket(
      ({ host }) => host === fixture.address,
      (socket) => {
        const server = socket.connectToServer()
        if (held || !destinationSeat()) return
        held = true
        server.onMessage((message) => {
          void greeting.promise.then(() => socket.send(message))
        })
      }
    )
    await page.addInitScript(() => {
      const { performance } = globalThis
      const now = performance.now.bind(performance)
      globalThis.expireTransferWait = () => {
        performance.now = () => now() + 12_000
      }
    })
    await page.goto('/?multiplayerDiagnostics=1')
    await page.getByLabel('場景模式').selectOption('multiplayer')
    await expect(map).toHaveText('Forest Entrance')
    const characterId = await scene.getAttribute('data-multiplayer-character-id')
    expect(characterId).toBeTruthy()
    await canvas.evaluate((element) => {
      globalThis.respawnCanvas = element
    })
    await page.getByRole('region', { name: '平台測試場' }).focus()
    await page.keyboard.down('ArrowRight')
    await expect.poll(async () => Number(await scene.getAttribute('data-local-authority-x'))).toBeGreaterThan(1000)
    await expect(hud).toContainText('倒地')
    await expect(hud).toContainText('HP 0 / 50')
    await page.keyboard.up('ArrowRight')
    await expect.poll(() => destinationSeat() && fixture.players(destinationSeat())).toEqual([characterId])
    const committedSeat = destinationSeat()
    await expect.poll(() => sourceClosed).toBe(true)
    await page.evaluate(() => globalThis.expireTransferWait())
    await expect(page.getByRole('status').filter({ hasText: '正在重連' })).toBeVisible()
    greeting.resolve()
    await expect(map).toHaveText('Village')
    await expect(hud).toContainText('HP 50 / 50')
    await expect(scene).toHaveAttribute('data-multiplayer-map-epoch', '1')
    await expect(scene).toHaveAttribute('data-multiplayer-character-id', characterId)
    await expect(scene).toHaveAttribute('data-remote-frame', '')
    await expect(scene).toHaveAttribute('data-peer-sprites', '0')
    await expect(scene).toHaveAttribute('data-monster-sprites', '')
    expect(fixture.players(sourceSeat())).not.toContain(characterId)
    expect(fixture.players(destinationSeat())).toEqual([characterId])
    expect(destinationSeat().roomId).toBe(committedSeat.roomId)
    expect(destinationSeat().sessionId).not.toBe(committedSeat.sessionId)
    await expect(canvas).toHaveCount(1)
    expect(await canvas.evaluate((element) => element === globalThis.respawnCanvas)).toBe(true)
    expect(errors).toEqual([])
  } finally {
    greeting.resolve()
    await fixture.close()
  }
})
