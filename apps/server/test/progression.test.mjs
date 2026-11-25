import { PROTOCOL_VERSION } from '@viesma/protocol'
import { setImmediate } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { createMemoryCharacterRepository } from '../src/runtime/memory-character-repository.ts'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'
import { progressionTestData } from './progression-fixture.mjs'
import { combatPeer, sendCombatInput } from './shared-combat-fixture.mjs'

const zero = { str: 0, dex: 0, int: 0, luk: 0 }

function harness(wrapRewardPort, dependencies = {}) {
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
    wrapRewardPort,
    rewardRandom: () => () => 0,
    ...dependencies,
  })
  const m1 = world.createRoom('m1')
  function peer() {
    return { ...combatPeer(), progression: vi.fn(), inventory: vi.fn() }
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

test('settles a real frozen death and publishes rewards only to the owner', async () => {
  let port
  const h = harness((memory) => (port = { ...memory, commitReward: vi.fn(memory.commitReward) }))
  const owner = h.join()
  const observer = h.join()
  await h.advance()
  h.attack(owner)
  await h.advance(8)
  const [[intent]] = port.commitReward.mock.calls
  const [{ value: receipt }] = port.commitReward.mock.results
  expect(Object.isFrozen(intent)).toBe(true)
  expect(intent.groups[0].eligibleCharacterIds).toEqual([owner.session.characterId])
  expect(h.snapshot(owner)).toMatchObject({ level: 2, characterVersion: 1 })
  expect(h.snapshot(observer)).toMatchObject({ level: 1, characterVersion: 0 })
  const loot = (peer) => h.world.ownerGroundLoot(h.m1, peer.connection).update.loot
  expect(
    loot(owner)
      .map(({ lootId }) => lootId)
      .sort()
  ).toEqual(receipt.grants.map(({ lootId }) => lootId).sort())
  expect(loot(observer)).toEqual([])
  expect(observer.progression).not.toHaveBeenCalled()
  expect(owner.progression).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      reward: { sequence: 1, experience: 100, levelsGained: 1, lootCount: receipt.grants.length },
    })
  )
  const unrelated = JSON.stringify([h.m1.snapshot(), h.snapshot(observer), loot(observer)])
  for (const { lootId } of receipt.grants) expect(unrelated).not.toContain(JSON.stringify(lootId))
  h.world.disposeRoom(h.m1)
})

test('settles solo EXP once after lost acknowledgements, source disposal, transfer and reconnect', async () => {
  const gate = Promise.withResolvers()
  let port
  const h = harness(
    (memory) =>
      (port = {
        releaseReceipt: vi.fn(memory.releaseReceipt),
        commitReward: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error('before commit')
          })
          .mockImplementationOnce(async (intent) => {
            await gate.promise
            memory.commitReward(intent)
            throw new Error('acknowledgement lost')
          })
          .mockImplementation(memory.commitReward),
      })
  )
  const village = h.world.createRoom('village')
  const owner = h.join()
  const observer = h.join()
  await h.advance()
  h.m1.respawn(owner.connection, { ...h.body(owner), vitals: { ...h.body(owner).vitals, hp: 37, mp: 12 } })
  h.attack(owner)
  await h.advance(8)
  expect(port.commitReward).toHaveBeenCalledTimes(2)
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
  expect(h.snapshot(recovered, village).level).toBe(2)
  expect(recovered.progression.mock.calls.filter(([update]) => update.reward)).toHaveLength(0)
  await h.advance(2)
  expect(port.commitReward).toHaveBeenCalledTimes(3)
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
  let port
  const h = harness(
    (memory) =>
      (port = {
        ...memory,
        commitReward: vi
          .fn()
          .mockImplementationOnce(memory.commitReward)
          .mockImplementation(async (intent) => {
            await secondReward.promise
            return memory.commitReward(intent)
          }),
      })
  )
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

function inventoryRequest(h, owner, requestId, operation, fields = {}, room = h.m1) {
  const { connectionEpoch, mapEpoch } = owner.session
  const request = {
    protocolVersion: PROTOCOL_VERSION,
    connectionEpoch,
    mapEpoch,
    requestEpoch: connectionEpoch,
    expectedCharacterVersion: h.world.inventory(room, owner.connection).characterVersion,
    requestId,
    ...operation,
    ...fields,
  }
  h.world.requestEquipment(room, owner.connection, request)
  return request
}

const unequipWeapon = (itemInstanceId) => ({ kind: 'unequip', slot: 'weapon', itemInstanceId })
const equip = (bagSlot, slot, itemInstanceId) => ({ kind: 'equip', bagSlot, slot, itemInstanceId })
const equipmentGrant = (itemDefinitionId, itemInstanceId) => ({ itemDefinitionId, itemInstanceId, quantity: 1 })
const inventoryResult = (owner) => owner.inventory.mock.lastCall?.[0].result?.code

test('validates equipment ownership, identity, level and slot and clamps live vitals without healing', async () => {
  const h = harness()
  const owner = h.join()
  const observer = h.join()
  const view = () => h.world.inventory(h.m1, owner.connection)
  const id = owner.session.characterId
  await h.advance()
  const first = h.world.queueInventoryGrant(id, 'accessory', equipmentGrant('accessory_tier_1', 'my-accessory'))
  const second = h.world.queueInventoryGrant(id, 'high', equipmentGrant('sword_tier_5', 'high-sword'))
  await h.advance()
  expect(await first).toBe('CONFIRMED')
  expect(await second).toBe('CONFIRMED')
  const before = view()
  const forged = inventoryRequest(h, owner, 1, equip(2, 'weapon', 'my-accessory'))
  h.world.requestEquipment(h.m1, observer.connection, forged)
  expect(inventoryResult(observer)).toBe('STALE_BINDING')
  expect(observer.inventory.mock.lastCall[0].characterId).toBe(observer.session.characterId)
  inventoryRequest(h, observer, 1, equip(2, 'accessory', 'my-accessory'))
  await h.advance()
  expect(inventoryResult(owner)).toBe('WRONG_SLOT')
  expect(inventoryResult(observer)).toBe('SOURCE_CHANGED')
  expect(h.world.inventory(h.m1, observer.connection).characterVersion).toBe(0)
  inventoryRequest(h, owner, 2, equip(3, 'weapon', 'high-sword'))
  await h.advance()
  expect(inventoryResult(owner)).toBe('LEVEL_REQUIRED')
  inventoryRequest(h, owner, 3, equip(2, 'accessory', 'stale-item'))
  await h.advance()
  expect(inventoryResult(owner)).toBe('SOURCE_CHANGED')
  expect(view()).toEqual(before)

  inventoryRequest(h, owner, 4, equip(2, 'accessory', 'my-accessory'))
  await h.advance()
  expect(inventoryResult(owner)).toBe('CONFIRMED')
  expect(view().equipment.accessory.itemInstanceId).toBe('my-accessory')
  expect(view().bag[2]).toBeNull()
  expect(h.snapshot(owner).stats).toMatchObject({ maxHp: 55, attackPower: 23 })
  expect(h.body(owner).vitals).toEqual({ hp: 50, mp: 30, maxHp: 55, maxMp: 30 })
  const body = h.body(owner)
  h.m1.respawn(owner.connection, { ...body, vitals: { ...body.vitals, hp: 54, mp: 11 } })
  inventoryRequest(h, owner, 5, { kind: 'unequip', slot: 'accessory', itemInstanceId: 'my-accessory' })
  await h.advance()
  expect(h.body(owner).vitals).toEqual({ hp: 50, mp: 11, maxHp: 50, maxMp: 30 })
  expect(view().equipment.accessory).toBeNull()
  expect(view().bag[2].itemInstanceId).toBe('my-accessory')

  const sword = view().equipment.weapon.itemInstanceId
  inventoryRequest(h, owner, 6, unequipWeapon(sword))
  await h.advance()
  expect(h.snapshot(owner).stats.attackPower).toBe(18)
  h.attack(owner)
  await h.advance(7)
  const damage = h.m1.combatDamageSince(-1).events.find(({ kind }) => kind === 'monster')
  expect(damage.amount).toBeLessThan(20)
  expect(h.m1.snapshot().monsters[0].hp).toBe(20 - damage.amount)
  const active = h.body(owner)
  h.m1.respawn(owner.connection, {
    ...active,
    action: { kind: 'death', diedAtTick: h.m1.snapshot().serverTick },
    vitals: { ...active.vitals, hp: 0 },
  })
  inventoryRequest(h, owner, 7, equip(4, 'weapon', sword))
  await h.advance()
  expect(inventoryResult(owner)).toBe('UNAVAILABLE')
  expect(h.body(owner).vitals.hp).toBe(0)
  expect(view().equipment.weapon).toBeNull()
  h.world.disposeRoom(h.m1)
})

test('serializes insert, AP, EXP and equipment in one version order and preserves state across travel and reconnect', async () => {
  const gate = Promise.withResolvers()
  const h = harness((memory) => ({
    ...memory,
    async commitReward(intent) {
      await gate.promise
      return memory.commitReward(intent)
    },
  }))
  const owner = h.join()
  const village = h.world.createRoom('village')
  const id = owner.session.characterId
  await h.advance()
  h.attack(owner)
  await h.advance(16)
  const original = h.world.inventory(h.m1, owner.connection)
  const sword = original.equipment.weapon.itemInstanceId
  const granting = h.world.queueInventoryGrant(id, 'fixture-potions', { itemDefinitionId: 'hp_potion', quantity: 100 })
  h.request(owner, h.payload(owner, 1, { str: 1 }))
  inventoryRequest(h, owner, 2, unequipWeapon(sword))
  gate.resolve()
  await setImmediate()
  await h.advance()
  expect(await granting).toBe('CONFIRMED')
  h.expectResult(owner, 1, 'STALE_VERSION')
  expect(inventoryResult(owner)).toBe('STALE_VERSION')
  expect(h.snapshot(owner)).toMatchObject({ level: 2, characterVersion: 2, unspentAp: 5 })
  const ap = h.payload(owner, 3, { str: 1 }, { expectedCharacterVersion: 2, requestEpoch: owner.session.connectionEpoch })
  h.request(owner, ap)
  inventoryRequest(h, owner, 4, unequipWeapon(sword))
  await h.advance()
  expect(owner.progression.mock.lastCall[0].result).toEqual({ requestId: 3, requestEpoch: ap.requestEpoch, code: 'CONFIRMED' })
  expect(inventoryResult(owner)).toBe('STALE_VERSION')

  const request = inventoryRequest(h, owner, 5, unequipWeapon(sword))
  h.world.requestEquipment(h.m1, owner.connection, request)
  h.world.requestEquipment(h.m1, owner.connection, { ...request, slot: 'armor' })
  expect(inventoryResult(owner)).toBe('REQUEST_CONFLICT')
  await h.advance()
  expect(inventoryResult(owner)).toBe('CONFIRMED')
  const newer = h.world.queueInventoryGrant(id, 'fixture-mp', { itemDefinitionId: 'mp_potion', quantity: 1 })
  await h.advance()
  expect(await newer).toBe('CONFIRMED')
  const current = h.world.inventory(h.m1, owner.connection)
  expect(current.characterVersion).toBe(5)
  expect(current.bag.slice(0, 4).map((item) => item.quantity)).toEqual([99, 4, 6, 1])
  expect(h.snapshot(owner).stats.attackPower).toBe(20)

  expect(h.world.requestPortal(h.m1, owner.connection, { requestId: 1, mapEpoch: 0, objectId: 'p_to_village' })).toBe(true)
  inventoryRequest(h, owner, 6, equip(3, 'weapon', sword))
  await h.advance()
  expect(inventoryResult(owner)).toBe('UNAVAILABLE')
  const [offer] = owner.offers
  const destination = h.peer()
  expect(h.world.acceptTransfer(village, destination, offer.ticket, owner.session.reconnectToken)).toBe(true)
  await h.advance()
  expect(h.world.inventory(h.m1, owner.connection)).toBeUndefined()
  h.world.requestEquipment(h.m1, owner.connection, request)
  expect(h.world.inventory(village, destination.connection)).toMatchObject({
    characterId: id,
    bag: current.bag,
    equipment: current.equipment,
  })
  h.world.leave(village, destination.connection, true)
  const recovered = h.peer()
  expect(h.world.reconnect(village, recovered, destination.session.reconnectToken)).toBe(true)
  h.world.requestEquipment(village, recovered.connection, request)
  expect(inventoryResult(recovered)).toBe('STALE_BINDING')
  const replay = { ...request, connectionEpoch: recovered.session.connectionEpoch, mapEpoch: recovered.session.mapEpoch }
  h.world.requestEquipment(village, recovered.connection, replay)
  expect(recovered.inventory.mock.lastCall[0]).toMatchObject({
    characterVersion: 5,
    bag: current.bag,
    result: { code: 'CONFIRMED', requestId: 5 },
  })
  h.world.requestEquipment(village, recovered.connection, { ...replay, slot: 'armor' })
  expect(inventoryResult(recovered)).toBe('REQUEST_CONFLICT')
  h.world.requestEquipment(village, recovered.connection, { ...replay, requestId: 99 })
  expect(inventoryResult(recovered)).toBe('STALE_REQUEST')
  h.request(recovered, { ...ap, connectionEpoch: recovered.session.connectionEpoch, mapEpoch: recovered.session.mapEpoch }, village)
  expect(recovered.progression.mock.lastCall[0]).toMatchObject({
    characterVersion: 5,
    result: { requestId: 3, requestEpoch: ap.requestEpoch, code: 'CONFIRMED' },
  })
  expect(h.snapshot(recovered, village)).toMatchObject({ characterId: id, characterVersion: 5, level: 2, unspentAp: 4 })
  h.world.disposeRoom(h.m1)
  h.world.disposeRoom(village)
})

test('drains an accepted solo reward after the last room and its owner have been removed', async () => {
  const gate = Promise.withResolvers()
  let port
  const h = harness(
    (memory) =>
      (port = {
        releaseReceipt: vi.fn(memory.releaseReceipt),
        commitReward: vi.fn(async (intent) => {
          await gate.promise
          return memory.commitReward(intent)
        }),
      })
  )
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
  const h = harness((memory) => ({
    ...memory,
    async commitReward(intent) {
      await gate.promise
      return memory.commitReward(intent)
    },
  }))
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

test('recovers committed progression and drops through a reconnect snapshot when the owner was disconnected at commit', async () => {
  const gate = Promise.withResolvers()
  const h = harness((memory) => ({
    ...memory,
    async commitReward(intent) {
      await gate.promise
      return memory.commitReward(intent)
    },
  }))
  const owner = h.join()
  await h.advance()
  h.attack(owner)
  await h.advance(6)
  h.world.leave(h.m1, owner.connection, true)
  gate.resolve()
  await setImmediate()
  await h.advance()
  expect(h.m1.snapshot().monsters[0].state).toBe('dead')
  expect(owner.progression).not.toHaveBeenCalled()
  expect(h.world.ownerGroundLoot(h.m1, owner.connection)).toBeUndefined()
  const rebound = h.peer()
  expect(h.world.reconnect(h.m1, rebound, owner.session.reconnectToken)).toBe(true)
  expect(h.snapshot(rebound)).toMatchObject({ characterId: owner.session.characterId, characterVersion: 1, level: 2 })
  expect(h.world.ownerGroundLoot(h.m1, rebound.connection).update.loot).toHaveLength(5)
  expect(rebound.progression).not.toHaveBeenCalled()
  h.world.disposeRoom(h.m1)
})

test('settles to a closed original identity without granting economy or drops to a new anonymous session', async () => {
  const gate = Promise.withResolvers()
  let repository
  let receipt
  const h = harness(
    (memory) => ({
      ...memory,
      async commitReward(intent) {
        await gate.promise
        receipt = memory.commitReward(intent)
        return receipt
      },
    }),
    {
      characterRepositoryFactory(...args) {
        repository = createMemoryCharacterRepository(...args)
        return repository
      },
    }
  )
  const owner = h.join()
  await h.advance()
  h.attack(owner)
  await h.advance(6)
  h.world.leave(h.m1, owner.connection)
  const replacement = h.join()
  expect(replacement.session.characterId).not.toBe(owner.session.characterId)
  expect(h.world.checkpoint(h.m1, owner.connection)).toBeUndefined()
  await h.advance()
  expect(h.m1.player(owner.session.characterId)).toBeUndefined()
  gate.resolve()
  await setImmediate()
  expect(repository.read(owner.session.characterId)).toMatchObject({ level: 2, version: 1 })
  expect(receipt.grants.every(({ ownerCharacterId }) => ownerCharacterId === owner.session.characterId)).toBe(true)
  await h.advance()
  expect(repository.read(owner.session.characterId)).toBeUndefined()
  expect(h.m1.player(owner.session.characterId)).toBeUndefined()
  expect(h.snapshot(replacement)).toMatchObject({ level: 1, characterVersion: 0 })
  expect(h.world.ownerGroundLoot(h.m1, replacement.connection).update.loot).toEqual([])
  expect(replacement.progression).not.toHaveBeenCalled()
  h.world.disposeRoom(h.m1)
})

test('rebinds a delayed reward after Village resurrection and disposal of its source instance', async () => {
  const gate = Promise.withResolvers()
  let receipt
  const h = harness((memory) => ({
    ...memory,
    async commitReward(intent) {
      await gate.promise
      receipt = memory.commitReward(intent)
      return receipt
    },
  }))
  const village = h.world.createRoom('village')
  const destination = h.world.createRoom('m1')
  const owner = h.join()
  await h.advance()
  h.attack(owner)
  await h.advance(6)
  const body = h.body(owner)
  h.m1.respawn(owner.connection, {
    ...body,
    action: { kind: 'death', diedAtTick: h.m1.snapshot().serverTick },
    vitals: { ...body.vitals, hp: 0 },
  })
  await h.advance(91)
  const recovered = h.peer()
  expect(h.world.acceptTransfer(village, recovered, owner.offers[0].ticket, owner.session.reconnectToken)).toBe(true)
  await h.advance()
  expect(h.body(recovered, village).vitals.hp).toBe(50)
  h.world.disposeRoom(h.m1)
  expect(h.m1.snapshot().monsters).toEqual([])
  expect(
    h.world.requestPortal(village, recovered.connection, {
      requestId: 1,
      mapEpoch: 1,
      objectId: 'p_to_m1',
    })
  ).toBe(true)
  await h.advance()
  const returned = h.peer()
  expect(h.world.acceptTransfer(destination, returned, recovered.offers[0].ticket, recovered.session.reconnectToken)).toBe(true)
  await h.advance()
  const before = h.body(returned, destination)
  expect(before.lifeStartedTick).not.toBe(body.lifeStartedTick)
  gate.resolve()
  await setImmediate()
  await h.advance()
  expect(h.body(returned, destination).vitals).toMatchObject({ hp: 50, maxHp: 60 })
  expect(h.body(returned, destination).lifeStartedTick).toBe(before.lifeStartedTick)
  expect(receipt.grants.every(({ placement }) => placement.sourceMapInstanceId === h.m1.mapInstanceId)).toBe(true)
  const loot = h.world.ownerGroundLoot(destination, returned.connection).update.loot
  expect(loot).toEqual(
    receipt.grants.map(({ lootId, expiresAtUtcMilliseconds, content }) => ({
      lootId,
      expiresAtUtcMilliseconds,
      content,
      position: receipt.position,
    }))
  )
  expect(returned.progression).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ level: 2, reward: expect.any(Object) }))
  expect(recovered.progression).not.toHaveBeenCalled()
  expect(owner.progression).not.toHaveBeenCalled()
  expect(h.m1.snapshot().monsters).toEqual([])
  h.world.disposeRoom(village)
  h.world.disposeRoom(destination)
})

test('a failed reward notification still confirms the monster death and preserves the private snapshots', async () => {
  const h = harness()
  const owner = h.join()
  const observer = h.join()
  owner.progression.mockImplementation(() => {
    throw Error('transport disconnected after commit')
  })
  await h.advance()
  h.attack(owner)
  await h.advance(8)
  expect(owner.progression).toHaveBeenCalledOnce()
  expect(h.snapshot(owner)).toMatchObject({ level: 2, characterVersion: 1 })
  expect(h.world.ownerGroundLoot(h.m1, owner.connection).update.loot).toHaveLength(5)
  expect(h.world.ownerGroundLoot(h.m1, observer.connection).update.loot).toEqual([])
  expect(h.m1.snapshot().monsters[0].state).toBe('dead')
  await h.advance(330)
  expect(h.m1.snapshot().monsters[0]).toMatchObject({ generation: 2, state: 'patrol' })
  expect(owner.progression).toHaveBeenCalledOnce()
  h.world.disposeRoom(h.m1)
})

test('replays an unacknowledged receipt after its loot expires while the monster is still pending', async () => {
  let utc = 1_000
  let original
  const acknowledgment = Promise.withResolvers()
  const replayed = vi.fn()
  const h = harness(
    (memory) => ({
      ...memory,
      async commitReward(intent) {
        const receipt = memory.commitReward(intent)
        if (original) {
          replayed(receipt)
          return receipt
        }
        original = receipt
        await acknowledgment.promise
        throw Error('acknowledgment lost')
      },
    }),
    { nowUtcMilliseconds: () => utc }
  )
  const owner = h.join()
  await h.advance()
  h.attack(owner)
  await h.advance(8)
  expect(original.grants).toHaveLength(5)
  expect(h.m1.snapshot().monsters[0].state).toBe('rewardPending')
  expect(owner.progression).not.toHaveBeenCalled()
  const first = h.world.ownerGroundLoot(h.m1, owner.connection)
  expect(first.update.loot).toHaveLength(5)
  utc += 120_000
  await h.advance()
  const expired = h.world.ownerGroundLoot(h.m1, owner.connection, first.feed)
  expect(expired.update).toMatchObject({ kind: 'delta', added: [], removed: original.grants.map(({ lootId }) => lootId) })
  acknowledgment.resolve()
  await setImmediate()
  await h.advance(2)
  expect(replayed).toHaveBeenCalledOnce()
  expect(replayed.mock.lastCall[0]).toBe(original)
  expect(h.world.ownerGroundLoot(h.m1, owner.connection, expired.feed)).toBeUndefined()
  expect(h.snapshot(owner)).toMatchObject({ characterVersion: 1, level: 2 })
  expect(owner.progression).toHaveBeenCalledOnce()
  expect(h.m1.snapshot().monsters[0].state).toBe('dead')
  h.world.disposeRoom(h.m1)
})
