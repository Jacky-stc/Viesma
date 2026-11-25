import { PROTOCOL_VERSION } from '@viesma/protocol'
import { setImmediate } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { createMemoryEncounterRewardPort } from '../src/runtime/encounter-reward-worker.ts'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'
import { progressionTestData } from './progression-fixture.mjs'
import { combatPeer, sendCombatInput } from './shared-combat-fixture.mjs'

const zero = { str: 0, dex: 0, int: 0, luk: 0 }

function harness(rewardPort) {
  let tick = 0
  let wake
  let id = 0
  const world = createWorldCoordinator(progressionTestData(), 'progression', {
    clock: { nowMilliseconds: () => tick * (1000 / 30) + (tick > 0 ? 0.0001 : 0) },
    nextId: () => `progression-${++id}`,
    onBacklog: vi.fn(),
    schedule(callback) {
      wake = callback
      return () => {
        wake = undefined
      }
    },
    rewardPort,
  })
  const m1 = world.createRoom('m1')
  function peer() {
    return { ...combatPeer(), progression: vi.fn() }
  }
  function join() {
    const owner = peer()
    expect(world.join(m1, owner)).toBe(true)
    return owner
  }
  async function advance(count = 1) {
    for (let index = 0; index < count; index++) {
      tick++
      wake?.()
      await setImmediate()
    }
  }
  const snapshot = (owner, room = m1) => world.progression(room, owner.connection)
  const body = (owner, room = m1) => room.player(owner.session.characterId)
  function payload(owner, requestId, deltas, fields = {}) {
    const { connectionEpoch, mapEpoch } = owner.session
    return {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      expectedCharacterVersion: 0,
      requestId,
      deltas: { ...zero, ...deltas },
      ...fields,
    }
  }
  function request(owner, data, room = m1) {
    world.requestAp(room, owner.connection, data)
  }
  function attack(owner) {
    expect(sendCombatInput(world, m1, owner, { attackPressed: true })).toBe(true)
  }
  function expectResult(owner, requestId, code) {
    expect(owner.progression.mock.lastCall?.[0].result).toEqual({ requestId, code })
  }
  return { world, m1, peer, join, advance, snapshot, body, payload, request, attack, expectResult, running: () => Boolean(wake) }
}

test('settles solo EXP once after lost acknowledgements, source disposal, transfer and reconnect', async () => {
  const gate = Promise.withResolvers()
  const memory = createMemoryEncounterRewardPort()
  const port = {
    releaseReceipt: vi.fn(memory.releaseReceipt),
    commitReward: vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('before commit')
      })
      .mockImplementationOnce((intent) => {
        memory.commitReward(intent)
        return Promise.reject(new Error('acknowledgement lost'))
      })
      .mockImplementation(async (intent) => {
        await gate.promise
        return memory.commitReward(intent)
      }),
  }
  const h = harness(port)
  const village = h.world.createRoom('village')
  const owner = h.join()
  const observer = h.join()
  await h.advance()
  h.m1.respawn(owner.connection, { ...h.body(owner), vitals: { ...h.body(owner).vitals, hp: 37, mp: 12 } })
  h.attack(owner)
  await h.advance(8)
  expect(port.commitReward).toHaveBeenCalledTimes(3)
  expect(port.commitReward.mock.calls.every(([intent]) => intent === port.commitReward.mock.calls[0][0])).toBe(true)
  expect(port.commitReward.mock.calls[0][0].groups).toMatchObject([
    { effectiveDamage: 20, eligibleCharacterIds: [owner.session.characterId] },
  ])
  expect(h.m1.snapshot().monsters[0]).toMatchObject({ state: 'rewardPending' })
  expect(h.snapshot(owner)).toMatchObject({ level: 1, characterVersion: 0, unspentAp: 0 })
  expect(h.snapshot(observer)).toMatchObject({ characterId: observer.session.characterId, level: 1, characterVersion: 0 })
  await h.advance(9)
  expect(h.world.requestPortal(h.m1, owner.connection, { requestId: 1, mapEpoch: 0, objectId: 'p_to_village' })).toBe(true)
  h.request(owner, h.payload(owner, 1, { str: 1 }))
  await h.advance()
  h.expectResult(owner, 1, 'UNAVAILABLE')
  const [offer] = owner.offers
  const destination = h.peer()
  expect(h.world.acceptTransfer(village, destination, offer.ticket, owner.session.reconnectToken)).toBe(true)
  expect(h.snapshot(destination, village)).toBeUndefined()
  await h.advance()
  expect(h.snapshot(owner)).toBeUndefined()
  expect(h.snapshot(destination, village)).toMatchObject({ characterId: owner.session.characterId, mapEpoch: 1, level: 1 })
  h.world.disposeRoom(h.m1)
  expect(port.releaseReceipt).not.toHaveBeenCalled()
  h.world.leave(village, destination.connection, true)
  const recovered = h.peer()
  expect(h.world.reconnect(village, recovered, destination.session.reconnectToken)).toBe(true)
  expect(recovered.session.connectionEpoch).not.toBe(destination.session.connectionEpoch)
  expect(h.snapshot(destination, village)).toBeUndefined()
  h.request(recovered, h.payload(destination, 2, { str: 1 }), village)
  h.expectResult(recovered, 2, 'STALE_BINDING')

  gate.resolve()
  await setImmediate()
  expect(h.snapshot(recovered, village).level).toBe(1)
  await h.advance()
  expect(h.snapshot(recovered, village)).toMatchObject({
    characterId: owner.session.characterId,
    connectionEpoch: recovered.session.connectionEpoch,
    mapEpoch: 1,
    level: 2,
    characterVersion: 1,
    unspentAp: 5,
    expWithinLevel: 0,
    nextLevelExp: 300,
  })
  expect(h.body(recovered, village).vitals).toEqual({ hp: 37, mp: 12, maxHp: 60, maxMp: 35 })
  expect(port.releaseReceipt).toHaveBeenCalledExactlyOnceWith(port.commitReward.mock.calls[0][0].claim.deathId)
  await h.advance(3)
  expect(h.snapshot(recovered, village).characterVersion).toBe(1)
  h.world.disposeRoom(village)
  expect(h.running()).toBe(false)
})

test('orders AP with EXP, reuses same-request confirmation, and rejects conflicting and stale mutations', async () => {
  const secondReward = Promise.withResolvers()
  const memory = createMemoryEncounterRewardPort()
  const port = {
    ...memory,
    commitReward: vi
      .fn()
      .mockImplementationOnce(memory.commitReward)
      .mockImplementation(async (intent) => {
        await secondReward.promise
        return memory.commitReward(intent)
      }),
  }
  const h = harness(port)
  const owner = h.join()
  const observer = h.join()
  const initial = h.payload(owner, 1, { str: 1 })
  await h.advance()
  h.request(observer, initial)
  h.expectResult(observer, 1, 'STALE_BINDING')
  expect(observer.progression.mock.lastCall[0].characterId).toBe(observer.session.characterId)
  h.request(owner, { ...initial, characterId: observer.session.characterId, expWithinLevel: 260000 })
  h.expectResult(owner, 1, 'INVALID_ALLOCATION')
  h.request(owner, { ...initial, deltas: { ...zero, str: -1 } })
  h.expectResult(owner, 1, 'INVALID_ALLOCATION')
  h.request(owner, initial)
  await h.advance()
  h.expectResult(owner, 1, 'INSUFFICIENT_AP')
  h.attack(owner)
  await h.advance(7)
  expect(h.snapshot(owner)).toMatchObject({ level: 2, characterVersion: 1 })
  expect(h.snapshot(observer)).toMatchObject({ level: 1, characterVersion: 0 })
  expect(h.m1.snapshot().players.find(({ characterId }) => characterId === owner.session.characterId)).not.toHaveProperty('baseAttributes')
  const first = h.payload(owner, 2, { str: 1 }, { expectedCharacterVersion: 1 })
  h.request(owner, first)
  h.request(owner, first)
  h.request(owner, { ...first, deltas: { ...zero, str: 2 } })
  h.expectResult(owner, 2, 'REQUEST_CONFLICT')
  expect(h.snapshot(owner).unspentAp).toBe(5)
  await h.advance()
  h.expectResult(owner, 2, 'CONFIRMED')
  h.request(owner, first)
  h.expectResult(owner, 2, 'CONFIRMED')
  h.request(owner, initial)
  h.expectResult(owner, 1, 'STALE_REQUEST')
  expect(h.snapshot(owner)).toMatchObject({
    unspentAp: 4,
    characterVersion: 2,
    baseAttributes: { ...zero, str: 5, dex: 4, int: 4, luk: 4 },
    stats: { attackPower: 23, maxHp: 65 },
  })
  expect(h.body(owner).vitals).toEqual({ hp: 50, mp: 30, maxHp: 65, maxMp: 35 })

  await h.advance(331)
  h.attack(owner)
  await h.advance(6)
  expect(port.commitReward).toHaveBeenCalledTimes(2)
  const before = h.snapshot(owner)
  h.request(owner, h.payload(owner, 3, { dex: 4 }, { expectedCharacterVersion: before.characterVersion }))
  secondReward.resolve()
  await setImmediate()
  await h.advance()
  h.expectResult(owner, 3, 'STALE_VERSION')
  expect(h.snapshot(owner)).toMatchObject({ expWithinLevel: 100, characterVersion: 3, unspentAp: 4 })
  h.request(owner, h.payload(owner, 4, { dex: 4 }, { expectedCharacterVersion: 3 }))
  await h.advance()
  h.expectResult(owner, 4, 'CONFIRMED')
  expect(h.snapshot(owner)).toMatchObject({
    expWithinLevel: 100,
    characterVersion: 4,
    unspentAp: 0,
    baseAttributes: { str: 5, dex: 8 },
    stats: { attackPower: 25, physicalDefense: 2 },
  })
  expect(h.m1.combatDamageSince(-1).events.at(-1)).toMatchObject({
    kind: 'monster',
    targetId: h.m1.snapshot().monsters[0].monsterId,
    generation: 2,
    amount: 20,
  })

  const dead = h.body(owner)
  h.m1.respawn(owner.connection, {
    ...dead,
    action: { kind: 'death', diedAtTick: h.m1.snapshot().serverTick },
    vitals: { ...dead.vitals, hp: 0 },
  })
  h.request(owner, h.payload(owner, 5, { dex: 1 }, { expectedCharacterVersion: 4 }))
  await h.advance()
  h.expectResult(owner, 5, 'UNAVAILABLE')
  expect(h.snapshot(owner).characterVersion).toBe(4)
  h.world.disposeRoom(h.m1)
})

test('drains an accepted solo reward after the last room and its owner have been removed', async () => {
  const gate = Promise.withResolvers()
  const memory = createMemoryEncounterRewardPort()
  const port = {
    releaseReceipt: vi.fn(memory.releaseReceipt),
    commitReward: vi.fn(async (intent) => {
      await gate.promise
      return memory.commitReward(intent)
    }),
  }
  const h = harness(port)
  const owner = h.join()
  await h.advance()
  h.attack(owner)
  await h.advance(6)
  expect(port.commitReward).toHaveBeenCalledTimes(1)
  h.world.disposeRoom(h.m1)
  expect(h.running()).toBe(true)
  gate.resolve()
  await setImmediate()
  await h.advance()
  expect(port.releaseReceipt).toHaveBeenCalledExactlyOnceWith(port.commitReward.mock.calls[0][0].claim.deathId)
  expect(h.running()).toBe(false)
  expect(h.snapshot(owner)).toBeUndefined()
  expect(owner.progression).not.toHaveBeenCalled()
})

test('applies a frozen solo grant if its recipient dies before confirmation without reviving them', async () => {
  const gate = Promise.withResolvers()
  const memory = createMemoryEncounterRewardPort()
  const port = {
    ...memory,
    async commitReward(intent) {
      await gate.promise
      return memory.commitReward(intent)
    },
  }
  const h = harness(port)
  const owner = h.join()
  await h.advance()
  h.attack(owner)
  await h.advance(6)
  const body = h.body(owner)
  const diedAtTick = h.m1.snapshot().serverTick
  h.m1.respawn(owner.connection, {
    ...body,
    action: { kind: 'death', diedAtTick },
    vitals: { ...body.vitals, hp: 0, mp: 11 },
  })
  gate.resolve()
  await setImmediate()
  await h.advance()
  expect(h.snapshot(owner)).toMatchObject({ level: 2, characterVersion: 1, unspentAp: 5 })
  expect(h.body(owner)).toMatchObject({
    action: { kind: 'death', diedAtTick },
    vitals: { hp: 0, maxHp: 60, mp: 11, maxMp: 35 },
  })
  h.world.disposeRoom(h.m1)
})
