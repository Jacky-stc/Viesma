import { parseGroundLootRequest, parseOwnerGroundLoot, PROTOCOL_VERSION } from '@viesma/protocol'
import { expect, test } from 'vitest'
import { createOwnerLootView, matchesOwnerLoot } from '../src/multiplayer/owner-loot-view.ts'

const binding = { characterId: 'owner', connectionEpoch: 'current', mapEpoch: 1, mapInstanceId: 'map:1', protocolVersion: PROTOCOL_VERSION }
const oldDrop = { lootId: 'loot:old', position: { x: 5, y: 60 }, expiresAtUtcMilliseconds: 1_200, content: { kind: 'currency', amount: 1 } }
const newDrop = { ...oldDrop, lootId: 'loot:new' }
const snapshot = (privateRevision, loot) => ({ ...binding, kind: 'snapshot', privateRevision, loot })
const delta = (baseRevision, privateRevision, added, removed) => ({
  ...binding,
  kind: 'delta',
  baseRevision,
  privateRevision,
  added,
  removed,
})

test('does not apply deltas before a snapshot or across a gap, and rejects a late snapshot older than the missing update', () => {
  const view = createOwnerLootView()
  expect(view.receive(delta(1, 2, [oldDrop], []))).toBe(true)
  expect(view.receive(delta(2, 3, [newDrop], []))).toBe(false)
  expect(view.receive(snapshot(2, [oldDrop]))).toBe(true)
  expect(view.loot().size).toBe(0)
  expect(view.receive(snapshot(3, [newDrop]))).toBe(false)
  expect([...view.loot().values()]).toEqual([newDrop])
  expect(view.receive(snapshot(1, [oldDrop]))).toBe(false)
  expect(view.receive(delta(1, 2, [oldDrop], []))).toBe(false)
  expect(view.receive(delta(3, 5, [], [newDrop.lootId]))).toBe(false)
  expect(view.loot().size).toBe(0)
})

test.each(['characterId', 'connectionEpoch', 'mapEpoch', 'mapInstanceId'])('rejects old or mismatched %s', (key) => {
  expect(matchesOwnerLoot(binding, binding, binding.mapInstanceId)).toBe(true)
  expect(matchesOwnerLoot({ ...binding, [key]: 'wrong' }, binding, binding.mapInstanceId)).toBe(false)
})

test('validates private DTOs and does not pass through extra payload fields into render data', () => {
  const update = parseOwnerGroundLoot(snapshot(1, [{ ...oldDrop, secretKey: 'fixture', ownerCharacterId: 'another' }]))
  expect(update).toEqual(snapshot(1, [oldDrop]))
  expect(parseOwnerGroundLoot(snapshot(1, [oldDrop, oldDrop]))).toBeUndefined()
  expect(parseOwnerGroundLoot(delta(1, 2, [oldDrop], [oldDrop.lootId]))).toBeUndefined()
  expect(parseOwnerGroundLoot(snapshot(1, [{ ...oldDrop, position: { x: 5, y: Infinity } }]))).toBeUndefined()
  const { protocolVersion, connectionEpoch, mapEpoch } = binding
  const header = { protocolVersion, connectionEpoch, mapEpoch, requestId: 0, expectedCharacterVersion: 0 }
  expect(parseGroundLootRequest({ ...header, lootId: oldDrop.lootId }, 'pickup')).toMatchObject({ kind: 'pickup' })
  expect(parseGroundLootRequest({ ...header, lootId: oldDrop.lootId, amount: 5 }, 'pickup')).toBeUndefined()
  expect(parseGroundLootRequest({ ...header, bagSlot: 24, itemDefinitionId: 'hp_potion' }, 'consume')).toBeUndefined()
})
