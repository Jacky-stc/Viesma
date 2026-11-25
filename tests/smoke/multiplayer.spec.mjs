import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { URL } from 'node:url'
import { joinSmokePeer, startBrowserFixtureServer } from '../../apps/server/test/browser-fixture-server.mjs'
import { movementSmokeMaxPlayerX } from '../../apps/server/test/movement-smoke-fixture.mjs'
import { installMovementRecorder, startMobileJumpTrace } from './mobile-jump-trace.mjs'

function monsterProjection(page) {
  return page
    .locator('.playground-canvas')
    .evaluate(({ dataset }) => ({ tick: Number(dataset.remoteSnapshotTick), monsters: JSON.parse(dataset.sharedMonsters ?? '[]') }))
}

async function routeFixtureRoom(page, fixture) {
  let seat
  await page.route('**/multiplayer/matchmake/joinOrCreate/map', async (route) => {
    seat = await fixture.reserve(route.request().postDataJSON())
    await route.fulfill({ json: seat })
  })
  return () => seat
}

async function routeFixtureTravel(page, fixture, beforeJoin = () => {}, onReserved) {
  let seat
  await page.route('**/multiplayer/matchmake/joinById/*', async (route) => {
    await beforeJoin(route.request().postDataJSON())
    const pathname = new URL(route.request().url()).pathname
    const response = await route.fetch({ url: `http://${fixture.address}${pathname.slice('/multiplayer'.length)}` })
    if (!response.ok()) return route.fulfill({ response })
    seat = { ...(await response.json()), publicAddress: fixture.address }
    onReserved?.(seat)
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

async function gateInputFrames(page, fixtureAddress, duplicateDamage = false) {
  const messageName = Buffer.from('InputFrame')
  const damageMessage = Buffer.from('CombatDamage')
  let blocked = false
  let dropped = 0
  let forwarded = 0
  let duplicated = 0
  let closed = false
  let jitter = false
  let incoming = 0
  let delayedBatches = 0
  let upstream
  await page.routeWebSocket(
    ({ host }) => host === fixtureAddress,
    (socket) => {
      const server = socket.connectToServer()
      upstream = server
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
        } else {
          socket.send(message)
          if (duplicateDamage && Buffer.isBuffer(message) && message.includes(damageMessage)) {
            duplicated++
            socket.send(message)
          }
        }
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
    send: (message) => upstream.send(message),
    dropped: () => dropped,
    duplicated: () => duplicated,
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

test('rejects forged damage and gives a fresh second browser the current melee HP', async ({ page, browser, baseURL }) => {
  const observer = await browser.newPage({ baseURL })
  const fixture = await startBrowserFixtureServer({ combatScenario: true })
  const errors = []
  const canvas = (client) => client.getByRole('img', { name: 'Beginner 平台場景' })
  const scene = (client) => client.locator('.playground-canvas')
  try {
    const attackerSeat = await routeFixtureRoom(page, fixture)
    const network = await gateInputFrames(page, fixture.address)
    const observerSeat = await routeFixtureRoom(observer, fixture)
    for (const client of [page, observer]) client.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/?multiplayerDiagnostics=1')
    await page.getByLabel('場景模式').selectOption('multiplayer')
    await expect(page.getByLabel('目前地圖')).toHaveText('Forest Entrance')
    const initial = (await monsterProjection(page)).monsters
    const slime = initial.find(({ x, y }) => x >= 464 && x <= 466 && y === 896)
    const hp = async (client) => (await monsterProjection(client)).monsters.find(({ monsterId }) => monsterId === slime.monsterId)?.hp
    expect(slime).toMatchObject({ archetypeId: 'slime', hp: 71 })

    network.block()
    const forged = fixture.malformedAttack(attackerSeat())
    network.send(forged.bytes)
    await expect.poll(forged.received).toBe(true)
    const { tick } = await monsterProjection(page)
    await expect.poll(async () => (await monsterProjection(page)).tick).toBeGreaterThanOrEqual(tick + 6)
    expect(await hp(page)).toBe(71)

    network.unblock()
    await page.getByRole('region', { name: '平台測試場' }).focus()
    await page.keyboard.press('KeyJ')
    await expect.poll(() => hp(page)).toBe(51)
    await observer.goto('/?multiplayerDiagnostics=1')
    await observer.getByLabel('場景模式').selectOption('multiplayer')
    await expect(observer.getByLabel('目前地圖')).toHaveText('Forest Entrance')
    for (const client of [page, observer]) await expect(client.getByLabel('同房角色數')).toHaveText('同房 2 人')
    expect(observerSeat().roomId).toBe(attackerSeat().roomId)
    await expect.poll(() => hp(observer)).toBe(51)
    await expect(scene(observer)).toHaveAttribute('data-combat-damage-seen', '0')
    await expect(scene(observer)).toHaveAttribute('data-combat-damage-sprites', '')

    expect(fixture.approachSlime(attackerSeat())).toBe(true)
    await expect(scene(page)).toHaveAttribute('data-local-authority-x', '435')
    await expect(page.getByLabel('Beginner 狀態')).toContainText('HP 43 / 50')
    await expect(observer.getByLabel('Beginner 狀態')).toContainText('HP 50 / 50')
    await Promise.all(
      [page, observer].map((client) => expect(scene(client)).toHaveAttribute('data-combat-damage-labels', /(^|,)\d+:7(,|$)/))
    )

    for (const client of [page, observer]) {
      await expect(canvas(client)).toHaveCount(1)
      await expect(scene(client)).toHaveAttribute('data-monster-sprites', initial.map(({ monsterId }) => monsterId).join(','))
      await expect(scene(client)).toHaveAttribute('data-peer-sprites', '1')
    }
    expect(await Promise.all([hp(page), hp(observer)])).toEqual([51, 51])
    expect(errors).toEqual([])
  } finally {
    await observer.close()
    await fixture.close()
  }
})

test('two browsers share combat feedback, confirmed corpse and a new monster generation before one Village recovery', async ({
  page,
  browser,
  baseURL,
}) => {
  const viewport = { width: 800, height: 450 }
  await page.setViewportSize(viewport)
  const other = await browser.newPage({ baseURL, viewport })
  const rewards = []
  const confirmation = Promise.withResolvers()
  const fixture = await startBrowserFixtureServer({
    combatScenario: true,
    beforeReward: () => confirmation.promise,
    observeReward(intent, receipt) {
      rewards.push({ intent, receipt })
    },
  })
  const clients = [page, other]
  const errors = []
  const scene = (client) => client.locator('.playground-canvas')
  const canvas = (client) => client.getByRole('img', { name: 'Beginner 平台場景' })
  try {
    const attackerSeat = await routeFixtureRoom(page, fixture)
    const observerSeat = await routeFixtureRoom(other, fixture)
    const villageSeat = await routeFixtureTravel(page, fixture)
    const rebound = await routeFixtureTravel(other, fixture)
    const networks = await Promise.all(clients.map((client) => gateInputFrames(client, fixture.address, true)))
    for (const client of clients) {
      client.on('pageerror', (error) => errors.push(error.message))
      await client.goto('/?multiplayerDiagnostics=1')
      await client.getByLabel('場景模式').selectOption('multiplayer')
      await expect(client.getByLabel('目前地圖')).toHaveText('Forest Entrance')
      await client.getByRole('region', { name: '平台測試場' }).focus()
    }
    for (const client of clients) await expect(client.getByLabel('同房角色數')).toHaveText('同房 2 人')
    for (const client of clients) {
      await scene(client).evaluate((element) => {
        const { MutationObserver } = globalThis
        globalThis.combatRenderedLabels = new Map()
        new MutationObserver(() => {
          for (const label of (element.dataset.combatDamageLabels ?? '').split(',')) {
            const [id, amount] = label.split(':')
            if (id) globalThis.combatRenderedLabels.set(id, amount)
          }
        }).observe(element, { attributes: true, attributeFilter: ['data-combat-damage-labels'] })
      })
    }
    await canvas(page).evaluate((element) => {
      globalThis.combatCanvas = element
    })
    const attackerId = await scene(page).getAttribute('data-multiplayer-character-id')
    const observerId = await scene(other).getAttribute('data-multiplayer-character-id')
    const initial = (await monsterProjection(page)).monsters
    const { monsterId } = initial.find(({ x, y }) => x >= 464 && x <= 466 && y === 896)
    const readOld = async (client) => (await monsterProjection(client)).monsters.find((monster) => monster.monsterId === monsterId)
    const authorityHp = () => fixture.monsterHp(attackerSeat(), monsterId)
    const initialHp = 71
    for (const client of clients) await expect.poll(() => readOld(client)).toMatchObject({ hp: initialHp, generation: 1 })
    let swings = 0
    let hp = initialHp
    while (swings < 4 && hp > 0) {
      await clients[swings % clients.length].keyboard.press('KeyJ')
      swings++
      await expect.poll(() => authorityHp() ?? initialHp).toBeLessThan(hp)
      const damage = hp - authorityHp()
      hp = authorityHp()
      await Promise.all(
        clients.map(async (client) => {
          await expect
            .poll(() =>
              scene(client).evaluate(
                (element, { monsterId, swingId }) => {
                  const monster = JSON.parse(element.dataset.sharedMonsters ?? '[]').find((value) => value.monsterId === monsterId)
                  return {
                    hp: monster?.hp,
                    state: monster?.state,
                    seen: Number(element.dataset.combatDamageSeen),
                    label: globalThis.combatRenderedLabels.get(swingId),
                  }
                },
                { monsterId, swingId: String(swings) }
              )
            )
            .toEqual({ hp, state: hp === 0 ? 'rewardPending' : 'patrol', seen: swings, label: String(damage) })
        })
      )
      if (hp > 0) fixture.advanceWorldTicks(18)
    }
    expect(hp).toBe(0)
    expect(networks.map((network) => network.duplicated())).toEqual([swings, swings])
    expect(rewards).toEqual([])
    expect(fixture.drop(observerSeat())).toBe(true)
    await expect.poll(() => rebound()?.roomId).toBe(observerSeat().roomId)
    await expect(scene(other)).toHaveAttribute('data-multiplayer-scene-revision', '2')
    await expect(scene(other)).toHaveAttribute('data-multiplayer-character-id', observerId)
    await expect.poll(() => readOld(other)).toMatchObject({ hp: 0, state: 'rewardPending', generation: 1 })
    await expect(scene(other)).toHaveAttribute('data-combat-damage-seen', '0')
    await expect(scene(other)).toHaveAttribute('data-combat-damage-sprites', '')

    confirmation.resolve()
    const initialSprites = initial.map(({ monsterId }) => monsterId).join(',')
    const remainingIds = initial.filter((monster) => monster.monsterId !== monsterId).map(({ monsterId }) => monsterId)
    await Promise.all(
      clients.map(async (client) => {
        await expect.poll(() => readOld(client)).toMatchObject({ hp: 0, state: 'dead', generation: 1 })
        await expect(scene(client)).toHaveAttribute('data-monster-sprites', initialSprites)
      })
    )
    expect(rewards).toHaveLength(1)
    const [{ intent, receipt }] = rewards
    expect(intent.claim).toMatchObject({ monsterId, generation: 1 })
    expect(receipt).toMatchObject({ deathId: intent.claim.deathId, encounterId: intent.claim.encounterId })
    expect(intent.groups).toHaveLength(2)
    expect(intent.groups.reduce((total, { effectiveDamage }) => total + effectiveDamage, 0)).toBe(initialHp)
    await Promise.all(
      clients.map(async (client) => {
        await expect.poll(() => readOld(client)).toMatchObject({ hp: 0, state: 'respawnWait' })
        await expect(scene(client)).toHaveAttribute('data-monster-sprites', remainingIds.join(','))
      })
    )
    expect(fixture.advanceWorldTicks(300)).toBeGreaterThanOrEqual(300)
    const readNew = async (client) => (await monsterProjection(client)).monsters.find(({ generation }) => generation === 2)
    await expect.poll(() => readNew(page)).toMatchObject({ generation: 2, hp: initialHp })
    const { monsterId: nextId } = await readNew(page)
    expect(nextId).not.toBe(monsterId)
    await Promise.all(
      clients.map(async (client) => {
        await expect.poll(() => readNew(client)).toMatchObject({ monsterId: nextId, generation: 2, hp: initialHp })
        expect(await readOld(client)).toBeUndefined()
        await expect
          .poll(() => scene(client).evaluate(({ dataset }) => (dataset.monsterSprites ?? '').split(',').sort()))
          .toEqual([...remainingIds, nextId].sort())
        await expect(scene(client)).toHaveAttribute('data-combat-damage-sprites', '')
        await expect(canvas(client)).toHaveCount(1)
      })
    )
    await expect(scene(other)).toHaveAttribute('data-combat-damage-seen', '0')
    await expect(scene(page)).toHaveAttribute('data-combat-damage-seen', String(swings))

    expect(fixture.approachSlime(attackerSeat(), 7)).toBe(true)
    const hud = page.getByLabel('Beginner 狀態')
    await expect(hud).toContainText('已倒下，等待返回 Village')
    await expect(hud).toContainText('HP 0 / 50')
    fixture.advanceWorldTicks(90)
    await expect(page.getByLabel('目前地圖')).toHaveText('Village')
    await expect(hud).toContainText('HP 50 / 50')
    await expect(hud).toContainText('重生保護')
    await expect(scene(page)).toHaveAttribute('data-multiplayer-map-epoch', '1')
    await expect(scene(page)).toHaveAttribute('data-multiplayer-character-id', attackerId)
    await expect(scene(page)).toHaveAttribute('data-combat-damage-seen', '0')
    await expect(scene(page)).toHaveAttribute('data-combat-damage-sprites', '')
    await expect(scene(page)).toHaveAttribute('data-monster-sprites', '')
    expect(fixture.players(attackerSeat())).toEqual([observerId])
    expect(fixture.players(villageSeat())).toEqual([attackerId])
    expect(await canvas(page).evaluate((element) => element === globalThis.combatCanvas)).toBe(true)
    await expect(canvas(page)).toHaveCount(1)
    expect(rewards).toHaveLength(1)
    expect(errors).toEqual([])
  } finally {
    confirmation.resolve()
    await other.close()
    await fixture.close()
  }
})

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

test('interpolates under patch jitter and shares M1 monsters through rejoin and reconnect', async ({ page, browser, baseURL }) => {
  test.slow()
  const mover = await browser.newPage({ baseURL })
  const fixture = await startBrowserFixtureServer()
  const errors = []
  const scene = (client) => client.locator('.playground-canvas')
  const canvas = (client) => client.getByRole('img', { name: 'Beginner 平台場景' })
  try {
    const network = await gateInputFrames(page, fixture.address)
    await routeFixtureRoom(page, fixture)
    const moverSeat = await routeFixtureRoom(mover, fixture)
    const recoveredSeat = await routeFixtureTravel(mover, fixture)
    for (const client of [page, mover]) {
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
    const initial = (await monsterProjection(page)).monsters
    const ids = initial.map(({ monsterId }) => monsterId)
    const sprites = ids.join(',')
    const readIds = async (client) => (await monsterProjection(client)).monsters.map(({ monsterId }) => monsterId)
    const readSlime = async (client) => (await monsterProjection(client)).monsters.find(({ monsterId }) => monsterId === slime.monsterId)
    const slime = initial.find(({ archetypeId, x, y }) => archetypeId === 'slime' && x >= 417 && x <= 513 && y === 896)
    expect(new Set(ids).size).toBe(10)
    expect(initial.filter(({ archetypeId }) => archetypeId === 'mushroom')).toHaveLength(4)
    expect(slime).toMatchObject({ archetypeId: 'slime', hp: 71, maxHp: 71, y: 896 })
    for (const client of [page, mover]) await expect(scene(client)).toHaveAttribute('data-monster-sprites', sprites)
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
    async function expectSharedPositions() {
      const [first, second] = (await Promise.all([history(page), history(mover)])).map((snapshots) => new Map(snapshots))
      const commonTicks = [...first.keys()].filter((tick) => second.has(tick))
      expect(commonTicks.length).toBeGreaterThanOrEqual(3)
      for (const tick of commonTicks) {
        expect(first.get(tick).map(({ monsterId }) => monsterId)).toEqual(ids)
        expect(first.get(tick)).toEqual(second.get(tick))
      }
    }
    await expectSharedPositions()

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
    await expect(scene(page)).toHaveAttribute('data-monster-sprites', sprites)
    await expect(canvas(mover)).toHaveCount(0)
    await mover.getByRole('button', { name: '載入場景' }).click()
    await expect(page.getByLabel('同房角色數')).toHaveText('同房 2 人')
    await expect(scene(page)).toHaveAttribute('data-peer-sprites', '1')
    await expect(scene(mover)).toHaveAttribute('data-monster-sprites', sprites)
    expect(await readSlime(mover)).toMatchObject({ hp: slime.hp })

    const disconnected = moverSeat()
    const character = await scene(mover).getAttribute('data-multiplayer-character-id')
    expect(fixture.drop(disconnected)).toBe(true)
    await expect.poll(() => recoveredSeat()?.roomId).toBe(disconnected.roomId)
    expect(recoveredSeat().sessionId).not.toBe(disconnected.sessionId)
    await expect(scene(mover)).toHaveAttribute('data-multiplayer-character-id', character)
    await expect(scene(mover)).toHaveAttribute('data-monster-sprites', sprites)
    await expectSharedPositions()

    for (const client of [page, mover]) {
      await expect.poll(() => readSlime(client)).toMatchObject({ hp: slime.hp, generation: 1 })
      await expect(scene(client)).toHaveAttribute('data-monster-sprites', sprites)
      await expect.poll(() => readIds(client)).toEqual(ids)
      await expect(canvas(client)).toHaveCount(1)
    }
    expect(errors).toEqual([])
  } finally {
    await mover.close()
    await fixture.close()
  }
})

test('plays the two-browser slice at 150 ms RTT through transfer and reconnect', async ({ page, browser, baseURL }, testInfo) => {
  const startedAt = performance.timeOrigin + performance.now()
  const marks = []
  function mark(kind, details = {}) {
    const tMs = Math.round(performance.timeOrigin + performance.now() - startedAt)
    if (marks.length < 64) marks.push({ kind, tMs, budgetMs: testInfo.timeout - tMs, ...details })
  }
  const traveler = await browser.newPage({ baseURL, viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })
  const fixture = await startBrowserFixtureServer({ movementScenario: true, traceMovement: true })
  const scene = (client) => client.locator('.playground-canvas')
  const canvas = (client) => client.getByRole('img', { name: 'Beginner 平台場景' })
  const map = (client) => client.getByLabel('目前地圖')
  const count = (client) => client.getByLabel('同房角色數')
  const hud = (client) => client.getByLabel('Beginner 狀態')
  const remote = (client) => scene(client).evaluate(({ dataset }) => (dataset.remoteFrame ? JSON.parse(dataset.remoteFrame) : null))
  async function expectObservedJump(player, spectator, startY, press, release, observeMinimum) {
    // 從輸入前開始記錄，避免輪詢錯過短暫的跳躍 HUD 或遠端高度。
    const [localJump, remoteJump] = await Promise.all([
      hud(player).evaluateHandle((element) => {
        let jumped = false
        const observer = new globalThis.MutationObserver(() => {
          jumped ||= element.textContent.includes('跳躍')
        })
        observer.observe(element, { childList: true, characterData: true, subtree: true })
        return { read: () => jumped, stop: () => observer.disconnect() }
      }),
      scene(spectator).evaluateHandle((host) => {
        let minY = Number.POSITIVE_INFINITY
        const observer = new globalThis.MutationObserver(() => {
          const frame = host.dataset.remoteFrame
          if (frame) minY = Math.min(minY, JSON.parse(frame).y)
        })
        observer.observe(host, { attributes: true, attributeFilter: ['data-remote-frame'] })
        return { read: () => minY, stop: () => observer.disconnect() }
      }),
    ])
    try {
      await press()
      await expect.poll(() => localJump.evaluate((trace) => trace.read()), { message: 'The player HUD should show a jump' }).toBe(true)
      await release?.()
      await expect
        .poll(async () => {
          const minimum = await remoteJump.evaluate((trace) => trace.read())
          observeMinimum?.(minimum)
          return minimum
        })
        .toBeLessThan(startY - 15)
    } finally {
      for (const trace of [localJump, remoteJump]) {
        await trace.evaluate((trace) => trace.stop())
        await trace.dispose()
      }
    }
  }
  const x = async () => Number(await scene(traveler).getAttribute('data-local-authority-x'))
  const predictedX = async () => Number(await scene(traveler).getAttribute('data-local-predicted-x'))
  const errors = []
  const { promise: allowRecovery, resolve: releaseRecovery } = Promise.withResolvers()
  let trips = 0
  let reconnects = 0
  let mobileTrace
  let travelerSeat
  let destinationSeat
  let phase = 'setup'
  function enterPhase(next) {
    phase = next
    mark('phase', { phase })
  }
  const travelerView = () =>
    scene(traveler).evaluate(({ dataset, ownerDocument }) => {
      const checkpoint = globalThis.__viesmaMovementSmoke.checkpoint
      return {
        roomId: checkpoint?.roomId,
        connectionEpoch: checkpoint?.connectionEpoch,
        mapEpoch: checkpoint?.mapEpoch,
        checkpointTick: checkpoint?.serverTick,
        checkpointX: checkpoint?.controller.x,
        x: Number(dataset.localAuthorityX),
        predictedX: Number(dataset.localPredictedX),
        revision: dataset.multiplayerSceneRevision,
        characterId: dataset.multiplayerCharacterId,
        map: ownerDocument.querySelector('[aria-label="目前地圖"]')?.textContent,
        status: Array.from(ownerDocument.querySelectorAll('.playground-status'), (element) => element.textContent),
      }
    })
  async function approachPortal(seat, { mapEpoch, portal, min, max }) {
    let releaseAt
    await traveler.keyboard.down('ArrowLeft')
    try {
      // 以權威角色進入門區為放鍵條件，為尚在傳輸中的移動幀留出煞停空間。
      await expect
        .poll(
          () => {
            releaseAt = fixture.movementAt(seat)
            return releaseAt?.x
          },
          { intervals: [25], message: 'The authoritative character should enter the portal approach' }
        )
        .toBeLessThan(max - 16)
      mark('release-direction', { phase, authority: releaseAt })
    } finally {
      await traveler.keyboard.up('ArrowLeft')
    }
    await Promise.all([
      expect(hud(traveler)).toContainText('待機'),
      expect
        .poll(
          async () => {
            const authority = fixture.movementAt(seat)
            const view = await travelerView()
            // 伺服器停穩時，本機可能仍在重播放鍵前的幀。等待同一連線的停穩 checkpoint。
            return {
              mapEpoch: view.mapEpoch,
              roomId: view.roomId,
              atRest: authority?.moveX === 0 && authority?.vx === 0,
              eligiblePortal: authority?.eligiblePortal,
              confirmedStop: authority != null && view.connectionEpoch === authority.connectionEpoch && view.checkpointX === authority.x,
              inRange: [authority?.x, view.x, view.predictedX].every((position) => position > min && position < max),
              positions: { authority: authority?.x, checkpoint: view.checkpointX, renderedPrediction: view.predictedX },
            }
          },
          { message: 'The authority and the reconciled client should settle inside the original portal bounds' }
        )
        .toMatchObject({ mapEpoch, roomId: seat.roomId, atRest: true, eligiblePortal: portal, confirmedStop: true, inRange: true }),
    ])
  }

  async function arrivalCheckpoint(expected) {
    await expect
      .poll(
        async () => {
          const reservation = destinationSeat()
          const view = await travelerView()
          return {
            ...view,
            matchesReservation: reservation !== undefined && view.roomId === reservation.roomId,
            trips,
            reconnects,
            arrivals: reservation ? fixture.players(reservation) : [],
            errors,
          }
        },
        { message: 'The destination checkpoint and visible scene should belong to the committed room' }
      )
      .toMatchObject({ matchesReservation: true, checkpointTick: expect.any(Number), ...expected })
  }
  enterPhase('setup')
  try {
    const observerSeat = await routeFixtureRoom(page, fixture)
    travelerSeat = await routeFixtureRoom(traveler, fixture)
    await Promise.all([page, traveler].map(installMovementRecorder))
    const networks = await Promise.all([page, traveler].map((client) => delayRoomTraffic(client, fixture.address, 75)))
    destinationSeat = await routeFixtureTravel(
      traveler,
      fixture,
      async ({ ticket }) => {
        mark('join-request', { transferTicket: Boolean(ticket), phase })
        if (ticket) trips++
        else {
          reconnects++
          await allowRecovery
        }
      },
      ({ roomId }) => mark('join-reserved', { roomId, phase })
    )
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
    await Promise.all(
      [page, traveler].map(async (client) => {
        client.on('pageerror', (error) => errors.push(error.message))
        await client.goto('/?multiplayerDiagnostics=1', { waitUntil: 'domcontentloaded' })
      })
    )
    await page.getByLabel('場景模式').selectOption('multiplayer')
    // 確保第二頁可加入第一頁所建立的房間。
    await expect.poll(() => observerSeat()?.roomId, { intervals: [25] }).toBeTruthy()
    await traveler.getByLabel('場景模式').selectOption('multiplayer')
    await Promise.all([
      ...[page, traveler].flatMap((client) => [
        expect(map(client)).toHaveText('Forest Entrance'),
        expect(client.getByText('開發用匿名身分 · 進度僅暫存於伺服器記憶體')).toBeVisible(),
        expect(count(client)).toHaveText('同房 2 人'),
      ]),
      expect(scene(traveler)).toHaveAttribute('data-multiplayer-scene-revision', '1'),
    ])
    const characterId = await scene(traveler).getAttribute('data-multiplayer-character-id')
    const monsters = (await monsterProjection(page)).monsters.map(({ monsterId, hp }) => ({ monsterId, hp }))
    const sprites = monsters.map(({ monsterId }) => monsterId).join(',')
    expect(characterId).toBeTruthy()
    expect(monsters).toHaveLength(10)
    await canvas(traveler).evaluate((element) => {
      globalThis.travelCanvas = element
    })
    await Promise.all(
      [page, traveler].flatMap((client) => [
        expect
          .poll(async () => (await monsterProjection(client)).monsters.map(({ monsterId, hp }) => ({ monsterId, hp })))
          .toEqual(monsters),
        expect.poll(() => remote(client)).toMatchObject({ y: 848 }),
      ])
    )

    const finishTickSample = fixture.measureTicks()
    enterPhase('keyboard-movement')
    const keyboardStart = await remote(traveler)
    await page.bringToFront()
    await page.getByRole('region', { name: '平台測試場' }).focus()
    await page.keyboard.down('ArrowLeft')
    await expect(hud(page)).toContainText('跑步 · 朝左')
    await expect.poll(async () => (await remote(traveler))?.x).toBeLessThan(keyboardStart.x - 24)
    await page.keyboard.up('ArrowLeft')
    await expectObservedJump(page, traveler, keyboardStart.y, () => page.keyboard.press('Space'))
    await expect(hud(page)).toContainText('待機')

    enterPhase('mobile-movement')
    mobileTrace = await startMobileJumpTrace(
      fixture,
      travelerSeat(),
      characterId,
      traveler,
      page,
      testInfo,
      browser.version(),
      marks,
      startedAt
    )
    mobileTrace.mark('before-bring-to-front')
    await traveler.bringToFront()
    mobileTrace.mark('after-bring-to-front')
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
    await expect.poll(predictedX, { intervals: [25] }).toBeGreaterThan(touchStart.x + 36)
    await releaseTouch()
    await expect.poll(async () => (await remote(page))?.x).toBeGreaterThan(touchStart.x + 24)
    await expect(hud(traveler)).toContainText('待機')
    expect(await x()).toBeLessThan(movementSmokeMaxPlayerX)
    await expectObservedJump(
      traveler,
      page,
      touchStart.y,
      () => {
        mobileTrace.mark('before-jump-touch', { startY: touchStart.y, thresholdY: touchStart.y - 15 })
        return pressTouch('跳躍')
      },
      () => {
        mobileTrace.mark('local-jump-observed')
        return releaseTouch()
      },
      (minimum) => mobileTrace.mark('observer-poll', { minimumY: Number.isFinite(minimum) ? minimum : null })
    )
    await mobileTrace.beginTransfer()
    await expect(hud(traveler)).toContainText('待機')

    enterPhase('m1-portal-approach')
    await traveler.getByRole('region', { name: '平台測試場' }).focus()
    await traveler.keyboard.down('ArrowUp')
    await approachPortal(travelerSeat(), { mapEpoch: 0, portal: 'p_to_village', min: 136, max: 256 })
    await expect(map(traveler)).toHaveText('Forest Entrance')
    expect(trips).toBe(0)
    enterPhase('transfer-to-village')
    await traveler.keyboard.up('ArrowUp')
    await traveler.keyboard.down('KeyW')
    await arrivalCheckpoint({
      map: 'Village',
      status: [],
      checkpointX: 1188,
      x: 1188,
      mapEpoch: 1,
      revision: '2',
      characterId,
      trips: 1,
      arrivals: [characterId],
      errors: [],
    })
    await Promise.all([
      expect(count(page)).toHaveText('同房 1 人'),
      expect(count(traveler)).toHaveText('同房 1 人'),
      expect(scene(traveler)).toHaveAttribute('data-multiplayer-map-epoch', '1'),
      expect(scene(traveler)).toHaveAttribute('data-remote-frame', ''),
      expect(scene(traveler)).toHaveAttribute('data-peer-sprites', '0'),
      expect(scene(traveler)).toHaveAttribute('data-monster-sprites', ''),
      expect(scene(page)).toHaveAttribute('data-monster-sprites', sprites),
    ])
    expect(fixture.players(observerSeat())).not.toContain(characterId)
    expect(fixture.players(destinationSeat())).toEqual([characterId])
    expect(trips).toBe(1)
    await traveler.keyboard.up('KeyW')

    enterPhase('village-reconnect')
    const villageSeat = destinationSeat()
    expect(fixture.drop(villageSeat)).toBe(true)
    await expect(traveler.getByRole('status').filter({ hasText: '正在重連' })).toBeVisible()
    expect(fixture.players(villageSeat)).toEqual([characterId])
    releaseRecovery()
    await arrivalCheckpoint({
      map: 'Village',
      roomId: villageSeat.roomId,
      mapEpoch: 1,
      revision: '3',
      characterId,
      arrivals: [characterId],
      reconnects: 1,
    })
    expect(fixture.players(destinationSeat())).toEqual([characterId])
    expect(destinationSeat().roomId).toBe(villageSeat.roomId)
    expect(destinationSeat().sessionId).not.toBe(villageSeat.sessionId)
    expect(reconnects).toBe(1)

    enterPhase('village-portal-approach')
    await approachPortal(destinationSeat(), { mapEpoch: 1, portal: 'p_to_m1', min: 1032, max: 1152 })
    enterPhase('transfer-to-m1')
    await pressTouch('進入傳送門')
    await arrivalCheckpoint({ map: 'Forest Entrance', roomId: observerSeat().roomId, mapEpoch: 2, revision: '4', characterId, trips: 2 })
    await releaseTouch()
    await Promise.all([
      expect(count(page)).toHaveText('同房 2 人'),
      expect(count(traveler)).toHaveText('同房 2 人'),
      expect(scene(traveler)).toHaveAttribute('data-multiplayer-map-epoch', '2'),
      expect(scene(traveler)).toHaveAttribute('data-peer-sprites', '1'),
      expect(scene(traveler)).toHaveAttribute('data-monster-sprites', sprites),
    ])
    expect(fixture.players(observerSeat()).filter((id) => id === characterId)).toHaveLength(1)
    expect(trips).toBe(2)

    enterPhase('final-presentation-and-metrics')
    const [resets, sameCanvas] = await Promise.all([
      traveler.evaluate(() => [...globalThis.sceneResets]),
      canvas(traveler).evaluate((element) => element === globalThis.travelCanvas),
      expect(canvas(page)).toHaveCount(1),
      expect(canvas(traveler)).toHaveCount(1),
    ])
    expect(resets).toEqual(['1', '2', '3', '4'].map((revision) => [revision, ['0', 'snap']]))
    expect(sameCanvas).toBe(true)
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
        phases: marks.filter(({ kind }) => kind === 'phase').map(({ phase, tMs }) => [phase, tMs]),
        traffic,
      })
    )
    mark('complete')
    if (process.env.VIESMA_CAPTURE_JUMP_TRACE === '1') await mobileTrace.finish(true)
  } catch (error) {
    if (mobileTrace) {
      mark('failure', {
        phase,
        source: fixture.movementAt(travelerSeat?.() ?? {}),
        destination: fixture.movementAt(destinationSeat?.() ?? {}),
      })
      await mobileTrace.finish(true).catch((traceError) => console.warn('Could not attach the mobile jump trace', traceError.message))
    }
    throw error
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

async function joinProgression(page, fixture) {
  const currentSeat = await routeFixtureRoom(page, fixture)
  await page.goto('/?multiplayerDiagnostics=1')
  await page.getByLabel('場景模式').selectOption('multiplayer')
  const hud = page.getByLabel('Beginner 狀態')
  await expect(hud).toContainText('Lv. 1')
  await expect(hud).toContainText('EXP 0 / 100')
  const seat = currentSeat()
  const authority = fixture.progressionAt(seat)
  await expect(page.locator('.playground-canvas')).toHaveAttribute('data-multiplayer-character-id', authority.characterId)
  return { seat, hud, authority }
}

test('shows private progression, waits for authority, and opens the AP panel with keyboard and landscape touch', async ({
  page,
  browser,
  baseURL,
}) => {
  const fixture = await startBrowserFixtureServer({ progressionScenario: true })
  const other = await browser.newPage({ baseURL, viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })
  let ownerSocket
  let oldSnapshot
  let confirmation
  let holdConfirmation = true
  const observerPackets = []
  try {
    await page.routeWebSocket(
      ({ host }) => host === fixture.address,
      (socket) => {
        ownerSocket = socket
        const server = socket.connectToServer()
        server.onMessage((message) => {
          if (Buffer.isBuffer(message) && message.includes('OwnerProgression')) {
            oldSnapshot ??= message
            if (holdConfirmation && message.includes('CONFIRMED')) {
              confirmation = message
              return
            }
          }
          socket.send(message)
        })
      }
    )
    await other.routeWebSocket(
      ({ host }) => host === fixture.address,
      (socket) => {
        const server = socket.connectToServer()
        server.onMessage((message) => {
          if (Buffer.isBuffer(message) && message.includes('OwnerProgression')) observerPackets.push(message)
          socket.send(message)
        })
      }
    )
    const owner = await joinProgression(page, fixture)
    const observer = await joinProgression(other, fixture)
    expect(owner.seat.roomId).toBe(observer.seat.roomId)
    expect(owner.authority.characterId).not.toBe(observer.authority.characterId)

    await other.getByRole('button', { name: '能力點數', exact: true }).tap()
    await expect(other.getByRole('dialog', { name: '能力點數' })).toContainText('可用 AP 0')
    await other.getByRole('button', { name: '關閉' }).tap()
    const surface = page.getByLabel('平台測試場')
    await surface.focus()
    await page.keyboard.press('j')
    await expect(owner.hud).toContainText('Lv. 2')
    await expect(owner.hud).toContainText('EXP 0 / 300')
    await expect(owner.hud).toContainText('HP 50 / 60')
    await expect(observer.hud).toContainText('Lv. 1')
    expect(fixture.progressionAt(observer.seat)).toMatchObject({
      characterId: observer.authority.characterId,
      level: 1,
      characterVersion: 0,
    })

    await page.keyboard.press('k')
    const panel = page.getByRole('dialog', { name: '能力點數' })
    await expect(panel).toContainText('可用 AP 5')
    const stat = (name) => panel.getByText(name, { exact: true }).locator('..').locator('dd')
    await expect(stat('攻擊力')).toHaveText('21')
    const str = panel.getByRole('spinbutton', { name: 'STR 配置' })
    const dex = panel.getByRole('spinbutton', { name: 'DEX 配置' })
    const allocate = panel.getByRole('button', { name: '配置 AP' })
    await str.fill('6')
    await allocate.click()
    await expect(panel.getByRole('status')).toHaveText('可用 AP 不足')
    await expect(panel).toContainText('可用 AP 5')

    await str.fill('1')
    await dex.fill('4')
    await allocate.click()
    await expect(panel.getByRole('status')).toHaveText('等待伺服器確認…')
    await expect(stat('攻擊力')).toHaveText('21')
    await expect.poll(() => Boolean(confirmation)).toBe(true)
    expect(fixture.progressionAt(owner.seat)).toMatchObject({
      characterId: owner.authority.characterId,
      characterVersion: 2,
      unspentAp: 0,
      baseAttributes: { str: 5, dex: 8 },
      stats: { maxHp: 65, attackPower: 25, physicalDefense: 2 },
    })
    holdConfirmation = false
    ownerSocket.send(confirmation)
    await expect(panel.getByRole('status')).toHaveText('能力點數已配置')
    await expect(stat('攻擊力')).toHaveText('25')
    await expect(stat('物理防禦')).toHaveText('2')
    await expect(panel.getByText('STR 5')).toBeVisible()
    await expect(owner.hud).toContainText('HP 50 / 65')

    ownerSocket.send(oldSnapshot)
    await str.fill('1')
    await allocate.click()
    await expect(panel.getByRole('status')).toHaveText('可用 AP 不足')
    await expect(stat('攻擊力')).toHaveText('25')
    await expect(owner.hud).toContainText('Lv. 2')
    await expect(observer.hud).toContainText('HP 50 / 50')
    expect(observerPackets.length).toBeGreaterThan(0)
    expect(observerPackets.every((message) => message.includes(observer.authority.characterId))).toBe(true)
    expect(observerPackets.some((message) => message.includes(owner.authority.characterId))).toBe(false)
    await page.keyboard.press('k')
    await expect(panel).toBeHidden()
  } finally {
    await other.close()
    await fixture.close()
  }
})

test('opens private inventory on keyboard and touch and reconciles equipment across reconnect and transfer', async ({
  page,
  browser,
  baseURL,
}) => {
  const fixture = await startBrowserFixtureServer({ inventoryScenario: true })
  const other = await browser.newPage({ baseURL, viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })
  const observerPackets = []
  let ownerSocket
  let initialInventory
  let lastConfirmation
  let holdConfirmation = false
  let heldConfirmation
  try {
    await page.routeWebSocket(
      ({ host }) => host === fixture.address,
      (socket) => {
        ownerSocket = socket
        const server = socket.connectToServer()
        server.onMessage((message) => {
          if (Buffer.isBuffer(message) && message.includes('OwnerInventory')) {
            initialInventory ??= message
            if (holdConfirmation && message.includes('CONFIRMED')) {
              heldConfirmation = message
              return
            }
            if (message.includes('CONFIRMED')) lastConfirmation = message
          }
          socket.send(message)
        })
      }
    )
    await other.routeWebSocket(
      ({ host }) => host === fixture.address,
      (socket) => {
        const server = socket.connectToServer()
        server.onMessage((message) => {
          if (Buffer.isBuffer(message)) observerPackets.push(message)
          socket.send(message)
        })
      }
    )
    const currentSeat = await routeFixtureTravel(page, fixture)
    const owner = await joinProgression(page, fixture)
    const observer = await joinProgression(other, fixture)
    const canvas = page.locator('.playground-canvas canvas')
    await canvas.evaluate((element) => {
      globalThis.inventoryCanvas = element
    })

    const mobilePanel = other.getByRole('dialog', { name: '物品欄' })
    await other.getByRole('button', { name: '物品欄', exact: true }).tap()
    await expect(mobilePanel.getByRole('listitem')).toHaveCount(27)
    await mobilePanel.getByRole('button', { name: /背包槽 1 · HP Potion ×5/ }).tap()
    await expect(mobilePanel.getByRole('region', { name: '物品詳情' })).toContainText('恢復 50 HP')
    await mobilePanel.getByRole('button', { name: '武器 · Training Sword' }).tap()
    await mobilePanel.getByRole('button', { name: '卸下裝備' }).tap()
    await expect(mobilePanel.getByRole('status')).toHaveText('裝備已更新')
    await expect(mobilePanel.getByText('武器 · 空')).toBeVisible()
    await mobilePanel.getByRole('button', { name: /背包槽 3 · Training Sword/ }).tap()
    await mobilePanel.getByRole('button', { name: '裝備物品' }).tap()
    await expect(mobilePanel.getByRole('button', { name: '武器 · Training Sword' })).toBeVisible()

    const id = owner.authority.characterId
    const accessory = { itemDefinitionId: 'accessory_tier_1', itemInstanceId: 'owner-private-accessory', quantity: 1 }
    expect(await fixture.grantInventory(id, 'accessory', accessory)).toBe('CONFIRMED')
    expect(
      await fixture.grantInventory(id, 'high-sword', { itemDefinitionId: 'sword_tier_5', itemInstanceId: 'owner-high-sword', quantity: 1 })
    ).toBe('CONFIRMED')
    const surface = page.getByLabel('平台測試場')
    await surface.focus()
    await page.keyboard.press('i')
    const panel = page.getByRole('dialog', { name: '物品欄' })
    await expect(panel.getByText('金幣 0')).toBeVisible()
    await expect(panel.getByRole('button', { name: /^背包槽 / })).toHaveCount(24)
    await panel.getByRole('button', { name: /^背包槽 4 · / }).click()
    await expect(panel.getByRole('region', { name: '物品詳情' })).toContainText('需求等級 5')
    await panel.getByRole('button', { name: '裝備物品' }).click()
    await expect(panel.getByRole('status')).toHaveText('角色等級不足')
    expect(fixture.inventoryAt(owner.seat).characterVersion).toBe(2)

    await panel.getByRole('button', { name: /^背包槽 3 · / }).click()
    await expect(panel.getByRole('region', { name: '物品詳情' })).toContainText('STR +1')
    holdConfirmation = true
    await panel.getByRole('button', { name: '裝備物品' }).click()
    await expect(panel.getByRole('status')).toHaveText('等待伺服器確認…')
    await expect(panel.getByRole('button', { name: '飾品 · 空' })).toBeVisible()
    await expect.poll(() => Boolean(heldConfirmation)).toBe(true)
    expect(fixture.inventoryAt(owner.seat)).toMatchObject({ characterVersion: 3, equipment: { accessory } })
    expect(fixture.progressionAt(owner.seat).stats).toMatchObject({ maxHp: 55, attackPower: 23 })

    holdConfirmation = false
    expect(fixture.drop(owner.seat)).toBe(true)
    await expect(panel.getByRole('status')).toHaveText('裝備已更新')
    const recovered = currentSeat()
    expect(recovered.sessionId).not.toBe(owner.seat.sessionId)
    expect(fixture.inventoryAt(recovered)).toMatchObject({ characterId: id, characterVersion: 3, equipment: { accessory } })
    ownerSocket.send(initialInventory)
    const equippedAccessory = panel.getByRole('button', { name: /^飾品 · (?!空)/ })
    await expect(equippedAccessory).toBeVisible()
    await expect(owner.hud).toContainText('HP 50 / 55')
    const oldConfirmation = lastConfirmation
    await equippedAccessory.click()
    await panel.getByRole('button', { name: '卸下裝備' }).click()
    await expect(panel.getByRole('button', { name: '飾品 · 空' })).toBeVisible()
    ownerSocket.send(oldConfirmation)
    await panel.getByRole('button', { name: /^背包槽 3 · / }).click()
    await panel.getByRole('button', { name: '裝備物品' }).click()
    await expect(equippedAccessory).toBeVisible()
    expect(fixture.inventoryAt(recovered).characterVersion).toBe(5)
    await page.keyboard.press('i')
    await expect(panel).toBeHidden()
    await surface.focus()
    expect(fixture.movementAt(recovered).eligiblePortal).toBe('p_to_village')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByLabel('目前地圖')).toHaveText('Village')
    const destination = currentSeat()
    expect(destination.roomId).not.toBe(recovered.roomId)
    expect(fixture.inventoryAt(destination)).toMatchObject({
      characterId: id,
      mapEpoch: 1,
      characterVersion: 5,
      currency: 0,
      equipment: { accessory },
    })
    await page.keyboard.press('i')
    await expect(panel.getByRole('button', { name: /^飾品 · (?!空)/ })).toBeVisible()

    const inventoryPackets = observerPackets.filter((message) => message.includes('OwnerInventory'))
    expect(inventoryPackets.length).toBeGreaterThan(0)
    expect(inventoryPackets.every((message) => message.includes(observer.authority.characterId))).toBe(true)
    expect(observerPackets.some((message) => message.includes('owner-private-accessory'))).toBe(false)
    await expect(canvas).toHaveCount(1)
    expect(await canvas.evaluate((element) => element === globalThis.inventoryCanvas)).toBe(true)
  } finally {
    await other.close()
    await fixture.close()
  }
})

test('picks up private drops and uses potions on keyboard and landscape touch across reconnect and transfer', async ({
  page,
  browser,
  baseURL,
}) => {
  const fixture = await startBrowserFixtureServer({ inventoryScenario: true, groundLootScenario: true })
  const mobile = await browser.newPage({ baseURL, viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })
  const mobilePackets = []
  const desktopPackets = []
  let desktopSocket
  let oldInventory
  let oldLoot
  let heldPickup
  let heldConsume
  let holdPickup = true
  let holdConsume = false
  async function inspectWire(target, packets) {
    await target.routeWebSocket(
      ({ host }) => host === fixture.address,
      (socket) => {
        if (target === page) desktopSocket = socket
        const server = socket.connectToServer()
        server.onMessage((message) => {
          if (Buffer.isBuffer(message)) {
            packets.push(message)
            if (target === page) {
              if (message.includes('OwnerInventory')) oldInventory ??= message
              if (message.includes('OwnerGroundLoot') && message.includes('snapshot')) oldLoot ??= message
              if (message.includes('OwnerLootCommandResult') && message.includes('CONFIRMED')) {
                if (holdPickup && message.includes('pickup')) {
                  heldPickup = message
                  return
                }
                if (holdConsume && message.includes('consume')) {
                  heldConsume = message
                  return
                }
              }
            }
          }
          socket.send(message)
        })
      }
    )
  }
  try {
    await inspectWire(page, desktopPackets)
    await inspectWire(mobile, mobilePackets)
    const travelSeat = await routeFixtureTravel(page, fixture)
    const desktop = await joinProgression(page, fixture)
    const touch = await joinProgression(mobile, fixture)
    expect(touch.seat.roomId).toBe(desktop.seat.roomId)
    const desktopStage = page.locator('.playground-canvas')
    const mobileStage = mobile.locator('.playground-canvas')
    const canvas = desktopStage.locator('canvas')
    await canvas.evaluate((element) => {
      globalThis.groundLootCanvas = element
    })
    await expect(desktop.hud).toContainText('金幣 0')
    await expect(touch.hud).toContainText('金幣 0')
    const coin = fixture.deliverGroundLoot(desktop.seat, { kind: 'currency', amount: 17 }, 'desktop-coin')
    await expect(desktopStage).toHaveAttribute('data-ground-loot-sprites', '1')
    await expect(mobileStage).toHaveAttribute('data-ground-loot-sprites', '0')
    await page.getByLabel('平台測試場').focus()
    await page.keyboard.press('f')
    const desktopPickup = page.getByRole('status', { name: '拾取結果' })
    await expect(desktopPickup).toHaveText('正在拾取…')
    await expect.poll(() => Boolean(heldPickup)).toBe(true)
    await expect(desktop.hud).toContainText('金幣 17')
    expect(fixture.inventoryAt(desktop.seat)).toMatchObject({ currency: 17, characterVersion: 1 })
    desktopSocket.send(oldInventory)
    const kept = fixture.deliverGroundLoot(desktop.seat, { kind: 'item', itemDefinitionId: 'hp_potion', quantity: 2 }, 'desktop-kept-item')
    await expect(desktopStage).toHaveAttribute('data-ground-loot-sprites', '1')
    await expect(desktop.hud).toContainText('金幣 17')
    holdPickup = false
    expect(fixture.drop(desktop.seat)).toBe(true)
    await expect(desktopPickup).toHaveText('拾取成功')
    const recovered = travelSeat()
    expect(recovered.sessionId).not.toBe(desktop.seat.sessionId)
    await expect(desktopStage).toHaveAttribute('data-ground-loot-sprites', '1')
    desktopSocket.send(oldLoot)

    const maxHp = fixture.progressionAt(recovered).stats.maxHp
    fixture.setLootVitals(recovered, { hp: 7 })
    await expect(desktop.hud).toContainText(`HP 7 / ${maxHp}`)
    await page.getByLabel('平台測試場').focus()
    holdConsume = true
    await page.keyboard.press('1')
    const desktopConsume = page.getByRole('status', { name: '藥水使用結果' })
    await expect.poll(() => Boolean(heldConsume)).toBe(true)
    await expect(desktopConsume).toHaveText('正在使用藥水…')
    const restoredHp = Math.min(7 + 50, maxHp)
    await expect(desktop.hud).toContainText(`HP ${restoredHp} / ${maxHp}`)
    expect(fixture.inventoryAt(recovered).bag[0].quantity).toBe(4)
    holdConsume = false
    expect(fixture.drop(recovered)).toBe(true)
    await expect(desktopConsume).toHaveText('已使用藥水')
    const healedSeat = travelSeat()
    expect(healedSeat.sessionId).not.toBe(recovered.sessionId)
    expect(fixture.movementAt(healedSeat)).toMatchObject({ characterId: desktop.authority.characterId, hp: restoredHp })
    expect(fixture.inventoryAt(healedSeat).bag[0].quantity).toBe(4)

    const mobileDrop = fixture.deliverGroundLoot(touch.seat, { kind: 'item', itemDefinitionId: 'hp_potion', quantity: 2 }, 'mobile-item')
    await expect(mobileStage).toHaveAttribute('data-ground-loot-sprites', '1')
    await mobile.getByRole('button', { name: '拾取', exact: true }).tap()
    await expect(mobile.getByRole('status', { name: '拾取結果' })).toHaveText('拾取成功')
    expect(fixture.inventoryAt(touch.seat).bag[0].quantity).toBe(7)
    await mobile.getByRole('button', { name: '物品欄', exact: true }).tap()
    const inventory = mobile.getByRole('dialog', { name: '物品欄' })
    await expect(inventory.getByRole('button', { name: /HP Potion ×7/ })).toBeVisible()
    await inventory.getByRole('button', { name: '關閉' }).tap()
    const maxMp = fixture.progressionAt(touch.seat).stats.maxMp
    fixture.setLootVitals(touch.seat, { mp: 1 })
    await expect.poll(() => fixture.movementAt(touch.seat).mp).toBe(1)
    await mobile.getByRole('button', { name: 'MP 藥水' }).tap()
    const mobileConsume = mobile.getByRole('status', { name: '藥水使用結果' })
    await expect(mobileConsume).toHaveText('已使用藥水')
    expect(fixture.movementAt(touch.seat).mp).toBe(Math.min(maxMp, 31))
    expect(fixture.inventoryAt(touch.seat).bag[1].quantity).toBe(2)
    fixture.advanceWorldTicks(31)
    await mobile.getByRole('button', { name: 'HP 藥水' }).tap()
    await expect(mobileConsume).toHaveText('數值已滿')
    expect(fixture.inventoryAt(touch.seat).bag[0].quantity).toBe(7)

    const expectPrivate = (packets, id, own, foreign) => {
      const privatePackets = packets.filter((message) => message.includes('OwnerGroundLoot') || message.includes('OwnerLootCommandResult'))
      expect(privatePackets.length).toBeGreaterThan(0)
      expect(privatePackets.every((message) => message.includes(id))).toBe(true)
      expect(privatePackets.some((message) => message.includes(own))).toBe(true)
      for (const otherId of foreign) expect(packets.some((message) => message.includes(otherId))).toBe(false)
    }
    expectPrivate(desktopPackets, desktop.authority.characterId, kept.lootId, [mobileDrop.lootId])
    expectPrivate(mobilePackets, touch.authority.characterId, mobileDrop.lootId, [coin.lootId, kept.lootId])
    fixture.placeAtLootFixturePortal(healedSeat, 'p_to_village')
    await expect.poll(() => fixture.movementAt(healedSeat).eligiblePortal).toBe('p_to_village')
    await expect(desktopStage).toHaveAttribute('data-local-predicted-x', String(fixture.movementAt(healedSeat).x))
    await page.keyboard.press('ArrowUp')
    await expect(page.getByLabel('目前地圖')).toHaveText('Village')
    await expect(desktopStage).toHaveAttribute('data-ground-loot-sprites', '0')
    const village = travelSeat()
    expect(fixture.movementAt(village)).toMatchObject({ characterId: desktop.authority.characterId, hp: restoredHp })
    expect(fixture.inventoryAt(village).bag[0].quantity).toBe(4)
    fixture.placeAtLootFixturePortal(village, 'p_to_m1')
    await expect.poll(() => fixture.movementAt(village).eligiblePortal).toBe('p_to_m1')
    await expect(desktopStage).toHaveAttribute('data-local-predicted-x', String(fixture.movementAt(village).x))
    await page.keyboard.press('ArrowUp')
    await expect(desktopStage).toHaveAttribute('data-multiplayer-map-epoch', '2')
    expect(travelSeat().roomId).toBe(desktop.seat.roomId)
    await expect(desktopStage).toHaveAttribute('data-ground-loot-sprites', '1')
    fixture.advanceLootClock(120_000)
    await expect(desktopStage).toHaveAttribute('data-ground-loot-sprites', '0')
    await expect(desktop.hud).toContainText('金幣 17')
    await expect(canvas).toHaveCount(1)
    expect(await canvas.evaluate((element) => element === globalThis.groundLootCanvas)).toBe(true)
  } finally {
    await mobile.close()
    await fixture.close()
  }
})
