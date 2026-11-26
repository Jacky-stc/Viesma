import { Client } from '@colyseus/sdk'
import { initialEncounterRewardBalance, initialPhysicsBalance } from '@viesma/game-data'
import { MapRoomSchema } from '@viesma/network-colyseus'
import {
  combatDamageMessage,
  consumeItemMessage,
  inputFrameMessage,
  interactPortalMessage,
  mapRoomJoinedMessage,
  mapRoomName,
  movementCheckpointMessage,
  ownerGroundLootMessage,
  ownerInventoryMessage,
  ownerLootCommandResultMessage,
  ownerProgressionMessage,
  pickupLootMessage,
  PROTOCOL_VERSION,
  transferFailureMessage,
  transferOfferMessage,
} from '@viesma/protocol'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { clearInterval, setInterval } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { count, counters, matchesOwner, privateStamp } from './capacity-observe.mjs'

const sockets = new Set()
let client
let version
let actors = []
let timer
let started
let stopped = false
const events = counters()
const errors = counters()
const processStart = process.cpuUsage()
const wallStart = performance.now()
const acquired = []

function safeError(error) {
  return { name: error.name, code: error.code, message: String(error.message).split('\n')[0] }
}

function send(message) {
  if (process.connected) process.send(message)
}

function fail(error) {
  send({ kind: 'error', error: safeError(error) })
}

async function waitFor(read, description, timeout = 5000) {
  const deadline = performance.now() + timeout
  for (;;) {
    const result = read()
    if (result) return result
    if (performance.now() >= deadline) throw new Error(description)
    await delay(10)
  }
}

async function open(actor, enter) {
  const room = await enter()
  sockets.add(room)
  room.reconnection.enabled = false
  const link = { room, seq: 0, nextInput: performance.now(), commandId: 0, portalId: 0, loot: new Map() }
  room.onLeave(() => {
    sockets.delete(room)
    link.closed = true
  })
  room.onMessage(mapRoomJoinedMessage, (binding) => {
    if (actor.characterId && actor.characterId !== binding.characterId) fail(new Error('Character changed across handoff'))
    actor.characterId = binding.characterId
    link.binding = binding
    actor.link = link
  })
  function privateMessage(type, handle) {
    room.onMessage(type, (payload) => {
      if (!matchesOwner(link.binding, payload)) {
        fail(new Error('Private message has a foreign character or epoch: ' + type))
        return
      }
      if (actor.link !== link || link.closed) {
        send({ kind: 'retiredPrivate', type, stamp: privateStamp(type, payload), roomId: room.roomId, sessionId: room.sessionId })
        return
      }
      handle(payload)
    })
  }
  privateMessage(movementCheckpointMessage, (payload) => (link.checkpoint = payload))
  privateMessage(ownerProgressionMessage, ({ characterVersion, reward }) => {
    link.version = Math.max(link.version ?? 0, characterVersion)
    if (!reward) return
    if (reward.sequence <= (actor.rewardSequence ?? 0)) fail(new Error('Repeated reward notification'))
    actor.rewardSequence = reward.sequence
    count(events, 'rewardNotifications')
  })
  privateMessage(ownerInventoryMessage, (payload) => {
    link.version = Math.max(link.version ?? 0, payload.characterVersion)
    link.inventory = payload
  })
  privateMessage(ownerGroundLootMessage, (update) => {
    if (update.kind === 'snapshot') link.loot.clear()
    for (const loot of update.kind === 'snapshot' ? update.loot : update.added) link.loot.set(loot.lootId, loot)
    if (update.kind === 'delta') for (const id of update.removed) link.loot.delete(id)
    count(events, 'groundUpdates')
  })
  privateMessage(ownerLootCommandResultMessage, ({ requestId, kind, code }) => {
    count(events, kind + ':' + code)
    if (code === 'PENDING' || link.pending?.payload.requestId !== requestId) return
    const { payload, type, repeat } = link.pending
    link.pending = undefined
    if (code === 'CONFIRMED' && repeat) {
      room.send(type, payload)
      count(events, 'replaysSent')
    }
  })
  room.onMessage(combatDamageMessage, () => count(events, 'combatBatches'))
  room.onMessage(transferFailureMessage, ({ code, requestId }) => {
    count(events, 'transferFailure:' + code)
    if (requestId !== null) link.portalPending = false
  })
  room.onMessage(transferOfferMessage, (offer) => {
    count(events, offer.requestId === null ? 'respawnOffers' : 'portalOffers')
    void (async () => {
      const joined = await open(actor, () =>
        client.joinById(offer.roomId, { ...version, ticket: offer.ticket, reconnectToken: link.binding.reconnectToken }, MapRoomSchema)
      )
      assert.equal(joined.binding.mapEpoch, offer.mapEpoch)
      assert.notEqual(joined.binding.connectionEpoch, link.binding.connectionEpoch)
      count(events, offer.requestId === null ? 'respawnTransfers' : 'portalTransfers')
      await waitFor(() => link.closed, 'Source socket remained open after transfer')
    })().catch((error) => {
      link.portalPending = false
      count(errors, 'transfer:' + (error.code ?? error.message))
    })
  })
  await waitFor(() => link.binding, 'Transport joined without authoritative character')
  return link
}

function movement(actor, link, now, position, grounded) {
  const { room } = link
  const map = room.state.mapId
  const feetX = position.x + initialPhysicsBalance.bodyWidthWorldUnits / 2
  const feetY = position.y + initialPhysicsBalance.bodyHeightWorldUnits
  const phase = Math.floor((now - started) / 1000)
  if (map === 'village' || (actor.role === 0 && phase >= actor.portalAt)) {
    const target = map === 'village' ? 1104 : 208
    const distance = target - feetX
    if (Math.abs(distance) <= 25 && grounded && !link.portalPending && now >= (link.nextPortal ?? 0)) {
      link.portalPending = true
      link.nextPortal = now + 2000
      if (map === 'm1') actor.portalAt = phase + 45
      room.send(interactPortalMessage, {
        requestId: ++link.portalId,
        mapEpoch: link.binding.mapEpoch,
        objectId: map === 'village' ? 'p_to_m1' : 'p_to_village',
      })
      count(events, 'portalRequests')
    }
    return { moveX: Math.abs(distance) > 12 ? Math.sign(distance) : 0, jumpPressed: false, attackPressed: false }
  }

  if (actor.role >= 16) return { moveX: 0, jumpPressed: false, attackPressed: false }
  if (actor.role >= 12) {
    const target = 320 + (Math.floor((phase + actor.role) / 3) % 2) * 90
    const jumpPressed = grounded && now >= (link.nextJump ?? 0)
    if (jumpPressed) link.nextJump = now + 1800 + actor.role * 53
    return { moveX: Math.abs(target - feetX) > 12 ? Math.sign(target - feetX) : 0, jumpPressed, attackPressed: false }
  }

  let target
  let best = Infinity
  for (const monster of room.state.monsters.values()) {
    if (monster.hp <= 0 || monster.x > 1230 || Math.abs(monster.y - feetY) > 55) continue
    const distance = Math.abs(feetX - monster.x)
    const score = distance + (actor.role >= 6 && monster.x < 795 ? 620 : 0)
    if (score < best) {
      best = score
      target = monster
    }
  }
  let nearestLoot
  let lootDistance = 160
  for (const loot of link.loot.values()) {
    const distance = Math.hypot(loot.position.x - feetX, loot.position.y - feetY)
    if (distance < lootDistance) {
      lootDistance = distance
      nearestLoot = loot
    }
  }
  if (nearestLoot && now >= (link.nextMutation ?? 0) && lootDistance <= initialEncounterRewardBalance.lootPickupRadiusWorldUnits - 5) {
    mutate(actor, link, now, pickupLootMessage, { lootId: nearestLoot.lootId })
  }

  const player = room.state.players.get(actor.characterId)
  if (player && player.hp > 0 && player.hp <= player.maxHp * 0.5 && now >= (link.nextMutation ?? 0)) {
    const bagSlot = link.inventory?.bag.findIndex((item) => item?.itemDefinitionId === 'hp_potion')
    if (bagSlot >= 0) mutate(actor, link, now, consumeItemMessage, { bagSlot, itemDefinitionId: 'hp_potion' })
  }

  const distance = (nearestLoot && lootDistance > 45 ? nearestLoot.position.x : (target?.x ?? (actor.role >= 6 ? 930 : 430))) - feetX
  const shouldAttack =
    target &&
    grounded &&
    Math.abs(target.x - feetX) <= 46 &&
    Math.abs(target.y - feetY) <= 17 &&
    link.checkpoint.controller.facing === (target.x < feetX ? 'left' : 'right') &&
    now >= (link.nextAttack ?? 0)
  if (shouldAttack) link.nextAttack = now + 520 + 13 * actor.role
  return {
    moveX: Math.abs(distance) > 12 || (!shouldAttack && target) ? Math.sign(distance) : 0,
    jumpPressed: false,
    attackPressed: !!shouldAttack,
  }
}

function mutate(actor, link, now, type, detail) {
  if (link.version === undefined || link.pending) return
  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    connectionEpoch: link.binding.connectionEpoch,
    mapEpoch: link.binding.mapEpoch,
    expectedCharacterVersion: link.version,
    requestId: ++link.commandId,
    ...detail,
  }
  link.nextMutation = now + 300
  link.pending = { payload, type, repeat: (actor.index + payload.requestId) % 7 === 0, at: now }
  link.room.send(type, payload)
  count(events, type)
}

function drive() {
  const now = performance.now()
  for (const actor of actors) {
    const { link } = actor
    if (!link?.checkpoint || link.closed || now < link.nextInput) continue
    link.nextInput = Math.max(link.nextInput + 1000 / 30, now + 5)
    if (link.pending && now - link.pending.at > 3000) {
      count(errors, 'mutationResultTimeout')
      link.pending = undefined
    }
    const { position, physics } = link.checkpoint.controller
    const input = movement(actor, link, now, position, physics.grounded)
    link.room.send(inputFrameMessage, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch: link.binding.connectionEpoch,
      mapEpoch: link.binding.mapEpoch,
      seq: link.seq++,
      ...input,
    })
    count(events, 'inputSent')
    if (input.moveX) count(events, 'movementSent')
    if (input.jumpPressed) count(events, 'jumpSent')
    if (input.attackPressed) count(events, 'attackSent')
  }
}

async function reconnect(index) {
  const actor = actors[index]
  const { link } = actor
  if (!link?.binding || link.portalPending || link.closed || actor.reconnecting) return
  actor.reconnecting = true
  try {
    send({ kind: 'drop', roomId: link.room.roomId, sessionId: link.room.sessionId })
    await waitFor(() => link.closed, 'Controlled drop did not close socket')
    await delay(300)
    const joined = await open(actor, () =>
      client.joinById(link.room.roomId, { ...version, reconnectToken: link.binding.reconnectToken }, MapRoomSchema)
    )
    assert.equal(joined.binding.mapEpoch, link.binding.mapEpoch)
    assert.notEqual(joined.binding.connectionEpoch, link.binding.connectionEpoch)
    count(events, 'reconnectSuccess')
  } catch (error) {
    count(errors, 'reconnect:' + (error.code ?? error.message))
  } finally {
    actor.reconnecting = false
  }
}

async function boot(message) {
  client = new Client(message.address)
  version = message.version
  for (let group = 0; group < message.rooms; group++) {
    const cohort = Array.from({ length: 20 }, (_, role) => ({ index: group * 20 + role, role, portalAt: 15 + group * 3 }))
    const first = await open(cohort[0], () => client.create(mapRoomName, version, MapRoomSchema))
    const joins = await Promise.allSettled(
      cohort.slice(1).map((actor) => open(actor, () => client.joinById(first.room.roomId, version, MapRoomSchema)))
    )
    for (const outcome of joins) {
      if (outcome.status === 'rejected') count(errors, 'initialAdmission:' + (outcome.reason.code ?? outcome.reason.message))
    }
    if (joins.some(({ status }) => status === 'rejected')) throw new Error('Fresh admission did not fill the cohort')
    acquired.push(first.room.roomId)
    actors.push(...cohort)
  }
  assert.equal(new Set(actors.map(({ characterId }) => characterId)).size, message.rooms * 20)
  try {
    const extra = await client.joinById(acquired[0], version, MapRoomSchema)
    sockets.add(extra)
    throw new Error('Transport accepted a 21st seat in a full room')
  } catch (error) {
    if (error.code === undefined) throw error
    send({ kind: 'fullRejection', error: safeError(error) })
  }
  send({ kind: 'ready', rooms: acquired })
  started = performance.now()
  timer = setInterval(drive, 8)
}

function snapshot() {
  const { user, system } = process.cpuUsage(processStart)
  return {
    cpuMs: (user + system) / 1000,
    elapsedMs: performance.now() - wallStart,
    memory: process.memoryUsage(),
    sockets: sockets.size,
    events,
    errors,
  }
}

async function close() {
  if (stopped) return
  stopped = true
  clearInterval(timer)
  send({ kind: 'clientSample', data: snapshot() })
  await Promise.race([Promise.allSettled([...sockets].map((room) => room.leave())), delay(2000)])
  process.disconnect()
}

process.on('message', (message) => {
  if (stopped) return
  if (message.kind === 'boot') void boot(message).catch(fail)
  if (message.kind === 'sample') send({ kind: 'clientSample', data: snapshot() })
  if (message.kind === 'reconnect') void reconnect(message.index)
  if (message.kind === 'stop') void close().catch(fail)
})
process.on('unhandledRejection', fail)
process.on('uncaughtException', fail)
process.on('disconnect', () => process.exit())
