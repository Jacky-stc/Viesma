import { currencyLimit } from '@viesma/domain'
import { consumableCooldownTicks, loadGrayboxGameData } from '@viesma/game-data'
import { parseOwnerGroundLoot, parseOwnerLootCommandResult, PROTOCOL_VERSION } from '@viesma/protocol'
import { placePlayerAtSpawn, playerFeet, ticksPerSecond } from '@viesma/simulation'
import { expect, test, vi } from 'vitest'
import { createMemoryCharacterRepository } from '../src/runtime/memory-character-repository.ts'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'
import { fixtureGroundGrant } from './ground-loot-fixture.mjs'
import { createRewardFixture } from './reward-fixture.mjs'
import { combatPeer } from './shared-combat-fixture.mjs'

const data = loadGrayboxGameData()
const currency = (amount = 17) => ({ kind: 'currency', amount })
const item = (itemDefinitionId = 'hp_potion', quantity = 2) => ({ kind: 'item', itemDefinitionId, quantity })
const hpPotion = { bagSlot: 0, itemDefinitionId: 'hp_potion' }
const mpPotion = { bagSlot: 1, itemDefinitionId: 'mp_potion' }

function harness({ initialInventory, onCommit } = {}) {
  let frame = 0
  let clockOffset = 0
  let utc = 0
  let id = 0
  let wake
  let repository
  const finalized = vi.fn((...args) => repository.finishConsumable(...args))
  const world = createWorldCoordinator(
    {
      ...data,
      tiledMaps: data.tiledMaps.map((map) => (map.id === 'm1' ? { ...map, monsterSpawns: [] } : map)),
    },
    'map-hash',
    {
      clock: { nowMilliseconds: () => (frame * 1000) / ticksPerSecond + clockOffset + 0.00001 },
      nowUtcMilliseconds: () => utc,
      nextId: () => `ground-${++id}`,
      onBacklog: vi.fn(),
      schedule(callback) {
        wake = callback
        return () => {
          wake = undefined
        }
      },
      characterRepositoryFactory(items, ground) {
        repository = createMemoryCharacterRepository(items, ground)
        return {
          ...repository,
          initialize(characterId, create) {
            return repository.initialize(characterId, () => {
              const state = create()
              return initialInventory ? { ...state, inventory: initialInventory(state.inventory) } : state
            })
          },
          commit(mutation, pickup) {
            const proceed = (next = mutation) => repository.commit(next, pickup)
            return onCommit ? onCommit(mutation, pickup, proceed) : proceed()
          },
          finishConsumable: finalized,
        }
      },
    }
  )
  const room = world.createRoom()
  const peer = () => ({ ...combatPeer(), lootResult: vi.fn() })
  function advance(count = 1) {
    for (let index = 0; index < count; index++) {
      frame++
      wake?.()
    }
  }
  function join(instance = room) {
    const owner = peer()
    expect(world.join(instance, owner)).toBe(true)
    advance()
    return owner
  }
  const body = (owner, instance = room) => instance.player(owner.session.characterId)
  function updateBody(owner, update, instance = room) {
    instance.respawn(owner.connection, update(body(owner, instance)))
  }
  function vitals(owner, changes, instance = room) {
    updateBody(owner, (body) => ({ ...body, vitals: { ...body.vitals, ...changes } }), instance)
  }
  function deliver(owner, content, options, instance = room) {
    const grant = fixtureGroundGrant(instance, owner.session.characterId, content, options)
    world.deliverCommittedGroundLoot(instance, [grant])
    return grant
  }
  const inventory = (owner, instance = room) => world.inventory(instance, owner.connection)
  const view = (owner, instance = room, previous, refresh) => world.ownerGroundLoot(instance, owner.connection, previous, refresh)
  const result = (owner) => owner.lootResult.mock.lastCall?.[0]
  function send(owner, kind, payload, instance = room) {
    world.requestGroundLoot(instance, owner.connection, payload, kind)
  }
  function request(owner, requestId, operation, { room: instance = room, implicitOrigin = false, ...overrides } = {}) {
    const kind = 'lootId' in operation ? 'pickup' : 'consume'
    const { connectionEpoch, mapEpoch } = owner.session
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      requestId,
      ...(!implicitOrigin && { requestEpoch: connectionEpoch }),
      expectedCharacterVersion: inventory(owner, instance).characterVersion,
      ...operation,
      ...overrides,
    }
    send(owner, kind, payload, instance)
    return payload
  }
  function portal(owner, from, to) {
    const portal = from.map.portals.find(({ destinationMapId }) => destinationMapId === to.map.id)
    updateBody(owner, (body) => placePlayerAtSpawn(body, { ...body.position, x: portal.bounds.origin.x + 16 }, 'right'), from)
    expect(world.requestPortal(from, owner.connection, { requestId: 1, mapEpoch: owner.session.mapEpoch, objectId: portal.id })).toBe(true)
  }
  function accept(from, destination) {
    const next = peer()
    expect(world.acceptTransfer(destination, next, from.offers.at(-1).ticket, from.session.reconnectToken)).toBe(true)
    advance()
    return next
  }
  function reconnect(owner, instance = room) {
    world.leave(instance, owner.connection, true)
    return rebind(owner, instance)
  }
  function rebind(owner, instance = room) {
    const next = peer()
    expect(world.reconnect(instance, next, owner.session.reconnectToken)).toBe(true)
    return next
  }
  return {
    world,
    room,
    join,
    advance,
    body,
    updateBody,
    vitals,
    deliver,
    inventory,
    view,
    result,
    send,
    request,
    portal,
    accept,
    reconnect,
    rebind,
    peer,
    repository,
    finalized,
    jumpClock(milliseconds) {
      clockOffset += milliseconds
      wake?.()
    },
    utc: (value) => {
      utc = value
    },
  }
}

function replay(h, owner, kind, payload, instance = h.room) {
  const { connectionEpoch, mapEpoch } = owner.session
  h.send(owner, kind, { ...payload, connectionEpoch, mapEpoch }, instance)
}

test('publishes committed M5.2 rolls only to the owner and preserves the original grant after retries', () => {
  const h = harness()
  const owner = h.join()
  const observer = h.join()
  const beforeOwner = h.view(owner)
  const beforeObserver = h.view(observer)
  const { characterId } = owner.session
  const secret = 'private-fixture-seed'
  const { reward, characters } = createRewardFixture(data, { nowUtcMilliseconds: () => 100, randomForEntry: () => () => secret.length % 1 })
  characters.open(characterId)
  const intent = {
    claim: {
      deathId: 'frozen-death',
      mapId: 'm1',
      mapInstanceId: h.room.mapInstanceId,
      spawnId: 'spawn_slime_1',
      position: playerFeet(h.body(owner)),
    },
    groups: [{ groupKey: `solo:${characterId}`, effectiveDamage: 1, eligibleCharacterIds: [characterId], contributions: [] }],
    balanceVersion: data.balanceVersion,
  }
  const { grants } = reward.commitReward(intent)
  expect(grants).toHaveLength(5)
  h.world.deliverCommittedGroundLoot(h.room, grants)
  const { update, feed } = h.view(owner, h.room, beforeOwner.feed)
  expect(parseOwnerGroundLoot(update)).toEqual(update)
  expect(update).toMatchObject({ kind: 'delta', baseRevision: 0, privateRevision: 5 })
  expect(update.added.map(({ expiresAtUtcMilliseconds }) => expiresAtUtcMilliseconds)).toEqual(Array(5).fill(120_100))
  expect(h.view(observer, h.room, beforeObserver.feed)).toBeUndefined()
  expect(h.view(observer).update.loot).toEqual([])
  const unrelated = JSON.stringify([h.room.snapshot(), h.view(observer).update])
  for (const { lootId } of grants) expect(unrelated).not.toContain(JSON.stringify(lootId))
  expect(JSON.stringify(update)).not.toContain(secret)
  expect(JSON.stringify(update)).not.toContain('tableEntryId')
  expect(h.inventory(owner).currency).toBe(0)
  h.utc(2_000)
  h.world.deliverCommittedGroundLoot(h.room, grants)
  expect(h.view(owner, h.room, feed)).toBeUndefined()
  expect(() => h.world.deliverCommittedGroundLoot(h.room, [{ ...grants[0], content: currency(50) }])).toThrow(/Conflicting/)
  expect(h.view(owner, h.room, feed)).toBeUndefined()
})

test('commits pickup of items and currency independently and replays the same receipt across reconnect', () => {
  const h = harness()
  const owner = h.join()
  const ownItem = h.deliver(owner, item())
  const ownCurrency = h.deliver(owner, currency(), { label: 'purse' })
  const { feed } = h.view(owner)
  const first = h.request(owner, 1, { lootId: ownItem.lootId })
  expect(h.result(owner).code).toBe('PENDING')
  h.advance()
  expect(parseOwnerLootCommandResult(h.result(owner))).toEqual(h.result(owner))
  expect(h.result(owner).code).toBe('CONFIRMED')
  expect(h.inventory(owner).characterVersion).toBe(1)
  expect(h.inventory(owner).bag[0].quantity).toBe(7)
  expect(h.view(owner, h.room, feed).update).toMatchObject({ kind: 'delta', added: [], removed: [ownItem.lootId] })
  h.request(owner, 1, { lootId: ownCurrency.lootId }, { expectedCharacterVersion: 0 })
  expect(h.result(owner).code).toBe('REQUEST_CONFLICT')
  h.request(owner, 2, { lootId: ownCurrency.lootId }, { expectedCharacterVersion: 0 })
  h.advance()
  expect(h.result(owner).code).toBe('STALE_VERSION')
  expect(h.inventory(owner).currency).toBe(0)
  const second = h.request(owner, 3, { lootId: ownCurrency.lootId })
  h.advance()
  expect(h.inventory(owner)).toMatchObject({ currency: 17, characterVersion: 2 })
  expect(h.inventory(owner).bag[0].quantity).toBe(7)
  const next = h.reconnect(owner)
  replay(h, next, 'pickup', first)
  expect(h.result(next)).toMatchObject({
    code: 'CONFIRMED',
    requestEpoch: first.requestEpoch,
    connectionEpoch: next.session.connectionEpoch,
  })
  replay(h, next, 'pickup', second)
  expect(h.result(next).code).toBe('CONFIRMED')
  h.request(next, 1, { lootId: ownItem.lootId })
  h.advance()
  expect(h.result(next).code).toBe('LOOT_UNAVAILABLE')
  expect(h.inventory(next)).toMatchObject({ currency: 17, characterVersion: 2 })
  expect(h.view(next).update.loot).toEqual([])
})

test('recovers full owner view after Village round trip and reconnect, fencing previous room, epoch and forged refresh', () => {
  const h = harness()
  const owner = h.join()
  const observer = h.join()
  const village = h.world.createRoom('village')
  const otherInstance = h.world.createRoom('m1')
  const drop = h.deliver(owner, currency())
  const foreign = h.deliver(observer, currency(99))
  const differentRoom = h.deliver(owner, currency(33), { position: playerFeet(h.body(owner)), label: 'other-room' }, otherInstance)
  const original = h.view(owner)
  h.request(observer, 1, { lootId: drop.lootId })
  h.request(owner, 1, { lootId: differentRoom.lootId })
  h.advance()
  expect(h.result(observer).code).toBe('LOOT_UNAVAILABLE')
  expect(h.result(owner).code).toBe('LOOT_UNAVAILABLE')
  expect(h.view(observer).update.loot.map(({ lootId }) => lootId)).toEqual([foreign.lootId])
  h.portal(owner, h.room, village)
  h.advance()
  const inVillage = h.accept(owner, village)
  const count = owner.lootResult.mock.calls.length
  expect(h.view(owner)).toBeUndefined()
  h.send(owner, 'pickup', { requestId: 12 })
  expect(owner.lootResult).toHaveBeenCalledTimes(count)
  expect(h.view(inVillage, village, original.feed).update).toMatchObject({ kind: 'snapshot', privateRevision: 0, loot: [] })
  h.request(inVillage, 1, { lootId: drop.lootId }, { room: village, connectionEpoch: owner.session.connectionEpoch })
  expect(h.result(inVillage).code).toBe('STALE_BINDING')
  h.portal(inVillage, village, h.room)
  h.advance()
  const back = h.accept(inVillage, h.room)
  expect(h.view(back).update.loot.map(({ lootId }) => lootId)).toEqual([drop.lootId])
  const next = h.reconnect(back)
  const nextView = h.view(next, h.room, original.feed)
  expect(nextView.update).toMatchObject({ kind: 'snapshot', connectionEpoch: next.session.connectionEpoch, privateRevision: 1 })
  expect(
    h.view(next, h.room, nextView.feed, {
      protocolVersion: PROTOCOL_VERSION,
      characterId: observer.session.characterId,
      mapEpoch: next.session.mapEpoch,
      connectionEpoch: back.session.connectionEpoch,
      mapInstanceId: h.room.mapInstanceId,
    })
  ).toBeUndefined()
  expect(
    h.view(next, h.room, nextView.feed, {
      protocolVersion: PROTOCOL_VERSION,
      characterId: next.session.characterId,
      mapEpoch: next.session.mapEpoch,
      connectionEpoch: next.session.connectionEpoch,
      mapInstanceId: h.room.mapInstanceId,
    }).update
  ).toEqual(nextView.update)
  expect(h.view(back)).toBeUndefined()
})

test('requires pickup at 96 units or less and an active living body outside transfer', () => {
  const h = harness()
  const owner = h.join()
  const feet = playerFeet(h.body(owner))
  const drop = h.deliver(owner, item(), { position: { x: feet.x - 96, y: feet.y } })
  h.updateBody(owner, (player) => ({ ...player, position: { ...player.position, x: player.position.x + 1 } }))
  h.request(owner, 1, { lootId: drop.lootId })
  h.advance()
  expect(h.result(owner).code).toBe('TOO_FAR')
  h.updateBody(owner, (player) => ({ ...player, position: { ...player.position, x: player.position.x - 1 } }))
  h.request(owner, 2, { lootId: drop.lootId })
  h.advance()
  expect(h.result(owner).code).toBe('CONFIRMED')

  const village = h.world.createRoom('village')
  h.portal(owner, h.room, village)
  const other = h.deliver(owner, item(), { label: 'during-transfer' })
  h.request(owner, 3, { lootId: other.lootId })
  h.advance()
  expect(h.result(owner).code).toBe('UNAVAILABLE')
  h.world.cancelTransfer(h.room, owner.connection, owner.offers.at(-1).ticket)
  h.advance()
  h.updateBody(owner, (player) => ({
    ...player,
    action: { kind: 'death', diedAtTick: h.room.snapshot().serverTick },
    vitals: { ...player.vitals, hp: 0 },
  }))
  h.request(owner, 4, { lootId: other.lootId })
  h.advance()
  expect(h.result(owner).code).toBe('UNAVAILABLE')
  expect(h.view(owner).update.loot.map(({ lootId }) => lootId)).toContain(other.lootId)
})

test('rebinds unexpired ground only after the source instance disappears in the same process', () => {
  const h = harness()
  const owner = h.join()
  const village = h.world.createRoom('village')
  const nextField = h.world.createRoom('m1')
  const drop = h.deliver(owner, currency(), { expiresAt: 10_000 })
  const original = h.view(owner).update.loot[0]
  const expired = h.deliver(owner, item(), { label: 'expired-in-village', expiresAt: 100 })
  h.portal(owner, h.room, village)
  h.advance()
  const across = h.accept(owner, village)
  h.world.disposeRoom(h.room)
  h.utc(200)
  h.portal(across, village, nextField)
  h.advance()
  const back = h.accept(across, nextField)
  expect(h.view(back, nextField).update).toMatchObject({ mapInstanceId: nextField.mapInstanceId, loot: [original] })
  h.request(back, 1, { lootId: expired.lootId }, { room: nextField })
  h.advance()
  expect(h.result(back).code).toBe('LOOT_UNAVAILABLE')
  h.request(back, 2, { lootId: drop.lootId }, { room: nextField })
  h.advance()
  expect(h.result(back).code).toBe('CONFIRMED')
  expect(h.inventory(back, nextField).currency).toBe(17)
})

test.each([99, 98])('a full bag with an HP stack of %i cannot accept two items atomically', (quantity) => {
  const h = harness({
    initialInventory: (inventory) => ({
      ...inventory,
      bag: inventory.bag.map((_, slot) => ({
        kind: 'stack',
        itemDefinitionId: slot === 0 ? 'hp_potion' : 'mp_potion',
        metadata: {},
        quantity: slot === 0 ? quantity : 99,
      })),
    }),
  })
  const owner = h.join()
  const drop = h.deliver(owner, item())
  h.request(owner, 1, { lootId: drop.lootId })
  h.advance()
  expect(h.result(owner).code).toBe('BAG_FULL')
  expect(h.inventory(owner).bag[0].quantity).toBe(quantity)
  expect(h.view(owner).update.loot).toMatchObject([{ lootId: drop.lootId, expiresAtUtcMilliseconds: 120_000 }])
  const gold = h.deliver(owner, currency(), { label: 'full-bag-gold' })
  h.request(owner, 2, { lootId: gold.lootId })
  h.advance()
  expect(h.inventory(owner).currency).toBe(17)
})

test('rejects purse overflow and permits exactly the purse cap', () => {
  const h = harness({ initialInventory: (inventory) => ({ ...inventory, currency: currencyLimit - 1 }) })
  const owner = h.join()
  const big = h.deliver(owner, currency(2))
  h.request(owner, 1, { lootId: big.lootId })
  h.advance()
  expect(h.result(owner).code).toBe('CURRENCY_LIMIT')
  expect(h.view(owner).update.loot[0].lootId).toBe(big.lootId)
  const one = h.deliver(owner, currency(1), { label: 'one-coin' })
  h.request(owner, 2, { lootId: one.lootId })
  h.advance()
  expect(h.inventory(owner).currency).toBe(currencyLimit)
})

test.each(['pickup', 'expiry', 'commit-edge'])('serializes pickup versus wall-clock expiry with winner %s', (winner) => {
  const h = harness({
    onCommit(_mutation, pickup, proceed) {
      if (pickup && winner === 'commit-edge') h.utc(1_000)
      return proceed()
    },
  })
  const owner = h.join()
  const drop = h.deliver(owner, currency(), { expiresAt: 1_000 })
  const { feed } = h.view(owner)
  h.utc(999)
  const request = h.request(owner, 1, { lootId: drop.lootId })
  if (winner === 'expiry') h.utc(1_000)
  h.advance()
  const expected = winner === 'pickup' ? 'CONFIRMED' : 'LOOT_EXPIRED'
  expect(h.result(owner).code).toBe(expected)
  h.utc(2_000)
  h.advance()
  const { update, feed: finished } = h.view(owner, h.room, feed)
  expect(update).toMatchObject({ kind: 'delta', privateRevision: 2, removed: [drop.lootId] })
  h.world.deliverCommittedGroundLoot(h.room, [drop])
  replay(h, owner, 'pickup', request)
  expect(h.result(owner).code).toBe(expected)
  expect(h.view(owner, h.room, finished)).toBeUndefined()
  expect(h.inventory(owner).currency).toBe(winner === 'pickup' ? 17 : 0)
})

test('pickup failure before commit rolls back both sides, and lost acknowledgement recovers the committed receipt', () => {
  let attempt = 0
  const h = harness({
    onCommit(_mutation, pickup, proceed) {
      if (!pickup) return proceed()
      if (++attempt === 1) throw new Error('before commit')
      proceed()
      throw new Error('ACK lost')
    },
  })
  const owner = h.join()
  const drop = h.deliver(owner, item('training_sword', 1))
  const { feed } = h.view(owner)
  const request = h.request(owner, 1, { lootId: drop.lootId })
  h.advance()
  expect(h.result(owner).code).toBe('BUSY')
  expect(h.inventory(owner).characterVersion).toBe(0)
  expect(h.view(owner, h.room, feed)).toBeUndefined()
  replay(h, owner, 'pickup', request)
  h.advance()
  expect(h.result(owner).code).toBe('CONFIRMED')
  const received = h.inventory(owner).bag.filter((slot) => slot?.itemDefinitionId === 'training_sword')
  expect(received).toHaveLength(1)
  expect(received[0].itemInstanceId).toMatch(/^loot:/)
  replay(h, owner, 'pickup', request)
  expect(h.result(owner).code).toBe('CONFIRMED')
  expect(h.inventory(owner).characterVersion).toBe(1)
  expect(h.view(owner).update.loot).toEqual([])
})

test('reserves one shared cooldown at admission and applies a committed potion once on the following tick', () => {
  const h = harness()
  const owner = h.join()
  h.vitals(owner, { hp: 1, mp: 1 })
  const hp = h.request(owner, 1, hpPotion)
  h.request(owner, 2, mpPotion)
  h.advance()
  expect(h.result(owner)).toMatchObject({ code: 'COOLDOWN', requestId: 2 })
  expect(
    h
      .inventory(owner)
      .bag.map((slot) => slot?.quantity)
      .slice(0, 2)
  ).toEqual([4, 3])
  expect(h.body(owner).vitals.hp).toBe(1)
  replay(h, owner, 'consume', hp)
  expect(h.result(owner).code).toBe('PENDING')
  h.advance()
  expect(h.result(owner)).toMatchObject({ code: 'CONFIRMED', requestId: 1 })
  expect(h.body(owner).vitals.hp).toBe(h.body(owner).vitals.maxHp)
  h.vitals(owner, { hp: 3 })
  replay(h, owner, 'consume', hp)
  h.advance(27)
  expect(h.body(owner).vitals.hp).toBe(3)
  h.request(owner, 3, mpPotion)
  h.advance()
  expect(h.result(owner).code).toBe('COOLDOWN')
  h.request(owner, 4, mpPotion)
  h.advance()
  expect(h.body(owner).vitals.mp).toBe(1)
  expect(h.inventory(owner).bag[1].quantity).toBe(2)
  h.vitals(owner, { maxMp: 100 })
  h.advance()
  expect(h.body(owner).vitals.mp).toBe(31)
  expect(h.inventory(owner).characterVersion).toBe(2)
})

test('clamps HP and MP to current maxima and rejects when either resource is full or the source mismatches', () => {
  const h = harness()
  const owner = h.join()
  for (const [requestId, operation, code] of [
    [1, hpPotion, 'RESOURCE_FULL'],
    [2, mpPotion, 'RESOURCE_FULL'],
    [3, { ...mpPotion, bagSlot: 2 }, 'SOURCE_CHANGED'],
    [4, { ...mpPotion, itemDefinitionId: 'unknown' }, 'INVALID_ITEM'],
  ]) {
    h.request(owner, requestId, operation)
    h.advance()
    expect(h.result(owner).code).toBe(code)
  }
  expect(h.inventory(owner).characterVersion).toBe(0)
  h.vitals(owner, { mp: 1 })
  h.request(owner, 5, mpPotion)
  h.advance()
  const { maxMp } = h.body(owner).vitals
  h.advance()
  expect(h.body(owner).vitals.mp).toBe(maxMp)
  h.advance(30)
  h.vitals(owner, { hp: 1 })
  h.request(owner, 6, hpPotion)
  h.advance()
  h.vitals(owner, { maxHp: 100 })
  h.advance()
  expect(h.body(owner).vitals.hp).toBe(51)
})

test('a failed potion commit releases reservation and a late acknowledgment applies one effect', () => {
  let attempt = 0
  const h = harness({
    onCommit({ receipt }, _pickup, proceed) {
      if (!receipt.effect) return proceed()
      if (++attempt === 1) throw new Error('before commit')
      proceed()
      throw new Error('late acknowledgement')
    },
  })
  const owner = h.join()
  h.vitals(owner, { hp: 7, mp: 1 })
  h.request(owner, 1, hpPotion)
  h.advance()
  expect(h.result(owner).code).toBe('BUSY')
  expect(h.inventory(owner).bag[0].quantity).toBe(5)
  const mp = h.request(owner, 2, mpPotion)
  h.advance()
  expect(h.inventory(owner).bag[1].quantity).toBe(2)
  h.advance()
  expect(h.body(owner).vitals.mp).toBe(h.body(owner).vitals.maxMp)
  h.vitals(owner, { mp: 2 })
  replay(h, owner, 'consume', mp)
  h.advance()
  expect(h.result(owner).code).toBe('CONFIRMED')
  expect(h.body(owner).vitals.mp).toBe(2)
  expect(h.inventory(owner).bag[1].quantity).toBe(2)
})

test('serializes pickup before a queued consume at the same expected version and releases the stale reservation', () => {
  const h = harness()
  const owner = h.join()
  h.vitals(owner, { hp: 7 })
  const drop = h.deliver(owner, currency())
  h.request(owner, 1, { lootId: drop.lootId })
  h.request(owner, 2, hpPotion)
  h.advance()
  expect(h.result(owner).code).toBe('STALE_VERSION')
  expect(h.inventory(owner)).toMatchObject({ currency: 17, characterVersion: 1 })
  expect(h.inventory(owner).bag[0].quantity).toBe(5)
  h.request(owner, 3, hpPotion)
  h.advance(2)
  expect(h.result(owner).code).toBe('CONFIRMED')
  expect(h.inventory(owner).bag[0].quantity).toBe(4)
})

test.each(['death', 'respawn'])('never applies a committed potion to an invalid body after %s', (fence) => {
  const h = harness()
  const owner = h.join()
  h.vitals(owner, { hp: 7 })
  const request = h.request(owner, 1, hpPotion)
  h.advance()
  expect(h.inventory(owner).bag[0].quantity).toBe(4)
  if (fence === 'death') {
    h.updateBody(owner, (body) => ({ ...body, action: { kind: 'death', diedAtTick: 2 }, vitals: { ...body.vitals, hp: 0 } }))
  } else {
    h.updateBody(owner, (body) => ({ ...body, lifeStartedTick: h.room.snapshot().serverTick }))
  }
  h.advance()
  expect(h.body(owner).vitals.hp).toBe(fence === 'death' ? 0 : 7)
  replay(h, owner, 'consume', request)
  expect(h.result(owner).code).toBe(fence === 'death' ? 'CONSUMED_DEAD' : 'CONSUMED_NO_EFFECT')
  if (fence === 'death') {
    h.request(owner, 2, hpPotion)
    h.advance()
    expect(h.result(owner).code).toBe('UNAVAILABLE')
  }
  expect(h.inventory(owner).bag[0].quantity).toBe(4)
})

test.each([
  { location: 'source', delay: 0, potion: hpPotion },
  { location: 'destination', delay: 1, potion: mpPotion },
])('applies the committed potion to the authoritative $location across portal handoff', ({ delay, potion }) => {
  const h = harness({
    onCommit(mutation, _pickup, proceed) {
      const { receipt } = mutation
      // 一般交接至少需要兩個 tick。此夾具把效果到期點後移一個 tick，驗證交接先完成的路徑。
      if (!delay || receipt.effect?.kind !== 'restoreMp') return proceed()
      return proceed({ ...mutation, receipt: { ...receipt, effect: { ...receipt.effect, dueTick: receipt.effect.dueTick + delay } } })
    },
  })
  const owner = h.join()
  const observer = h.join()
  const village = h.world.createRoom('village')
  const readyAt = h.room.snapshot().serverTick + consumableCooldownTicks
  h.vitals(owner, { hp: 7, mp: 1 })
  const original = h.body(owner)
  const healed = {
    hp: delay ? 7 : Math.min(7 + 50, original.vitals.maxHp),
    mp: delay ? Math.min(1 + 30, original.vitals.maxMp) : 1,
  }
  const request = h.request(owner, 1, potion, { implicitOrigin: true })
  h.advance()
  expect(h.inventory(owner).bag[potion.bagSlot].quantity).toBe(delay ? 2 : 4)
  expect(h.body(owner).vitals).toMatchObject({ hp: 7, mp: 1 })
  h.portal(owner, h.room, village)
  h.advance()
  expect(owner.offers).toHaveLength(1)
  expect(village.player(owner.session.characterId)).toBeUndefined()
  expect(h.body(owner).vitals).toMatchObject(delay ? { hp: 7, mp: 1 } : healed)
  expect(h.result(owner).code).toBe(delay ? 'PENDING' : 'CONFIRMED')
  const sourceResults = owner.lootResult.mock.calls.length
  const destination = h.accept(owner, village)
  expect(h.body(owner)).toBeUndefined()
  expect(h.body(destination, village)).toMatchObject({
    characterId: original.characterId,
    lifeStartedTick: original.lifeStartedTick,
    vitals: healed,
  })
  expect(destination.session.mapEpoch).toBe(owner.session.mapEpoch + 1)
  expect(destination.session.connectionEpoch).not.toBe(owner.session.connectionEpoch)
  const result = {
    code: 'CONFIRMED',
    characterId: owner.session.characterId,
    connectionEpoch: destination.session.connectionEpoch,
    mapEpoch: destination.session.mapEpoch,
    mapInstanceId: village.mapInstanceId,
    requestId: 1,
    requestEpoch: owner.session.connectionEpoch,
  }
  if (delay) expect(h.result(destination)).toMatchObject(result)
  else expect(destination.lootResult).not.toHaveBeenCalled()
  replay(h, destination, 'consume', { ...request, requestEpoch: request.connectionEpoch }, village)
  expect(h.result(destination)).toMatchObject(result)
  replay(h, owner, 'consume', request)
  expect(owner.lootResult).toHaveBeenCalledTimes(sourceResults)
  expect(observer.lootResult).not.toHaveBeenCalled()
  const otherPotion = delay ? hpPotion : mpPotion
  h.advance(readyAt - 1 - village.snapshot().serverTick)
  h.request(destination, 2, otherPotion, { room: village })
  h.advance()
  expect(h.result(destination).code).toBe('COOLDOWN')
  expect(
    h
      .inventory(destination, village)
      .bag.map((slot) => slot?.quantity)
      .slice(0, 2)
  ).toEqual(delay ? [5, 2] : [4, 3])
  h.request(destination, 3, otherPotion, { room: village })
  h.advance(2)
  expect(h.result(destination).code).toBe('CONFIRMED')
  expect(
    h
      .inventory(destination, village)
      .bag.map((slot) => slot?.quantity)
      .slice(0, 2)
  ).toEqual([4, 2])
})

test('keeps committed healing on the source when a portal offer is canceled', () => {
  const h = harness()
  const owner = h.join()
  const village = h.world.createRoom('village')
  h.vitals(owner, { hp: 7, mp: 1 })
  const original = h.body(owner)
  const request = h.request(owner, 1, hpPotion)
  h.advance()
  h.portal(owner, h.room, village)
  h.advance()
  h.request(owner, 2, mpPotion)
  h.advance()
  expect(h.result(owner).code).toBe('UNAVAILABLE')
  h.world.cancelTransfer(h.room, owner.connection, owner.offers.at(-1).ticket)
  h.advance()
  expect(h.body(owner)).toMatchObject({
    characterId: original.characterId,
    lifeStartedTick: original.lifeStartedTick,
    vitals: { hp: Math.min(7 + 50, original.vitals.maxHp), mp: 1 },
  })
  expect(village.player(original.characterId)).toBeUndefined()
  expect(h.inventory(owner).bag[0].quantity).toBe(4)
  expect(h.inventory(owner).bag[1].quantity).toBe(3)
  replay(h, owner, 'consume', request)
  expect(h.result(owner).code).toBe('CONFIRMED')
})

test.each([false, true])('keeps a committed potion across reconnect or grace (disconnected at due tick: %s)', (detachedAtDue) => {
  const h = harness()
  const owner = h.join()
  const observer = h.join()
  const readyAt = h.room.snapshot().serverTick + consumableCooldownTicks
  h.vitals(owner, { hp: 7, mp: 1 })
  const original = h.body(owner)
  const request = h.request(owner, 1, hpPotion)
  h.advance()
  const oldReplies = owner.lootResult.mock.calls.length
  h.world.leave(h.room, owner.connection, true)
  if (detachedAtDue) {
    h.advance()
    expect(h.body(owner).vitals.hp).toBe(Math.min(7 + 50, original.vitals.maxHp))
  }
  const recovered = h.rebind(owner)
  expect(recovered.session.characterId).toBe(owner.session.characterId)
  expect(recovered.session.mapEpoch).toBe(owner.session.mapEpoch)
  expect(recovered.session.connectionEpoch).not.toBe(owner.session.connectionEpoch)
  h.send(recovered, 'consume', request)
  expect(h.result(recovered).code).toBe('STALE_BINDING')
  if (!detachedAtDue) {
    replay(h, recovered, 'consume', request)
    expect(h.result(recovered).code).toBe('PENDING')
    h.advance()
    expect(h.result(recovered).code).toBe('CONFIRMED')
  }
  replay(h, recovered, 'consume', request)
  expect(h.result(recovered)).toMatchObject({
    code: 'CONFIRMED',
    requestId: 1,
    requestEpoch: owner.session.connectionEpoch,
    connectionEpoch: recovered.session.connectionEpoch,
  })
  expect(h.body(recovered)).toMatchObject({
    characterId: original.characterId,
    lifeStartedTick: original.lifeStartedTick,
    vitals: { hp: Math.min(7 + 50, original.vitals.maxHp), mp: 1 },
  })
  expect(h.inventory(recovered).bag[0].quantity).toBe(4)
  h.send(owner, 'consume', { ...request, connectionEpoch: recovered.session.connectionEpoch })
  expect(owner.lootResult).toHaveBeenCalledTimes(oldReplies)
  expect(observer.lootResult).not.toHaveBeenCalled()
  h.advance(readyAt - 1 - h.room.snapshot().serverTick)
  h.request(recovered, 2, mpPotion)
  h.advance()
  expect(h.result(recovered).code).toBe('COOLDOWN')
  expect(h.inventory(recovered).bag[1].quantity).toBe(3)
  h.request(recovered, 3, mpPotion)
  h.advance(2)
  expect(h.result(recovered).code).toBe('CONFIRMED')
  expect(h.inventory(recovered).bag[1].quantity).toBe(2)
})

test.each(['grace expiry', 'room disposal'])('finalizes pending committed healing when the session ends through %s', (cause) => {
  const h = harness()
  const owner = h.join()
  h.vitals(owner, { hp: 7 })
  h.request(owner, 1, hpPotion)
  h.advance()
  expect(h.inventory(owner).bag[0].quantity).toBe(4)
  const oldReplies = owner.lootResult.mock.calls.length
  const { characterId, reconnectToken } = owner.session
  h.world.leave(h.room, owner.connection, true)
  if (cause === 'grace expiry') h.jumpClock(30_000)
  else h.world.disposeRoom(h.room)
  expect(h.finalized).toHaveBeenCalledExactlyOnceWith(characterId, expect.any(String), 'CONSUMED_NO_EFFECT')
  expect(h.body(owner)).toBeUndefined()
  expect(h.repository.read(characterId)).toBeUndefined()
  expect(h.world.reconnect(h.room, h.peer(), reconnectToken)).toBe(false)
  expect(owner.lootResult).toHaveBeenCalledTimes(oldReplies)
})

test('duplicate commit and completion preserve the original heal outcome and debit once', () => {
  let key
  let duplicateCommit
  const h = harness({
    onCommit(mutation, _pickup, proceed) {
      if (!mutation.receipt.effect) return proceed()
      key = mutation.receipt.key
      const committed = proceed()
      duplicateCommit = proceed()
      return committed
    },
  })
  const owner = h.join()
  h.vitals(owner, { hp: 7 })
  const request = h.request(owner, 1, hpPotion)
  h.advance()
  expect(duplicateCommit?.kind).toBe('replayed')
  replay(h, owner, 'consume', request)
  expect(h.result(owner).code).toBe('PENDING')
  owner.lootResult.mockImplementationOnce(() => {
    throw new Error('completion delivery failed')
  })
  h.advance()
  expect(h.body(owner).vitals.hp).toBe(Math.min(57, h.body(owner).vitals.maxHp))
  const { characterId } = owner.session
  expect(h.finalized).toHaveBeenCalledExactlyOnceWith(characterId, key, 'CONFIRMED')
  h.repository.finishConsumable(characterId, key, 'CONSUMED_NO_EFFECT')
  h.vitals(owner, { hp: 3 })
  replay(h, owner, 'consume', request)
  h.advance()
  expect(h.body(owner).vitals.hp).toBe(3)
  expect(h.inventory(owner)).toMatchObject({ characterVersion: 1 })
  expect(h.inventory(owner).bag[0].quantity).toBe(4)
  expect(h.result(owner).code).toBe('CONFIRMED')
  expect(h.finalized).toHaveBeenCalledOnce()
})

test('a new anonymous play session cannot use the retired session receipt or its ground view', () => {
  const h = harness()
  const owner = h.join()
  h.vitals(owner, { hp: 4 })
  const drop = h.deliver(owner, currency())
  const request = h.request(owner, 1, hpPotion)
  h.advance()
  expect(h.inventory(owner).bag[0].quantity).toBe(4)
  h.world.leave(h.room, owner.connection)
  expect(h.finalized).toHaveBeenCalledExactlyOnceWith(owner.session.characterId, expect.any(String), 'CONSUMED_NO_EFFECT')
  const next = h.join()
  expect(next.session.characterId).not.toBe(owner.session.characterId)
  replay(h, next, 'consume', request)
  expect(h.result(next).code).toBe('STALE_REQUEST')
  h.request(next, 1, { lootId: drop.lootId })
  h.advance()
  expect(h.result(next).code).toBe('LOOT_UNAVAILABLE')
  expect(h.inventory(next).bag[0].quantity).toBe(5)
  expect(h.view(next).update.loot).toEqual([])
})
