import { bagSlotCount, currencyLimit } from '@viesma/domain'
import { expect, test } from 'vitest'
import { parseEquipmentRequest, parseOwnerInventory, PROTOCOL_VERSION } from '../src/index.ts'

const common = {
  protocolVersion: PROTOCOL_VERSION,
  expectedCharacterVersion: 7,
  requestId: 4,
  requestEpoch: 'original',
  connectionEpoch: 'reconnected',
  mapEpoch: 1,
}
const equip = { ...common, kind: 'equip', slot: 'weapon', itemInstanceId: 'sword', bagSlot: 23 }
const snapshot = {
  protocolVersion: PROTOCOL_VERSION,
  characterId: 'owner',
  connectionEpoch: 'reconnected',
  mapEpoch: 1,
  characterVersion: 8,
  currency: currencyLimit,
  bag: Array(bagSlotCount).fill(null),
  equipment: { weapon: { itemDefinitionId: 'training_sword', itemInstanceId: 'sword', quantity: 1 }, armor: null, accessory: null },
  result: { requestId: 4, requestEpoch: 'original', code: 'CONFIRMED' },
}

test('parses equipment intent with current transport binding and independent original request identity', () => {
  expect(parseEquipmentRequest(equip)).toEqual(equip)
  const unequip = { ...common, kind: 'unequip', slot: 'weapon', itemInstanceId: 'sword' }
  expect(parseEquipmentRequest(unequip)).toEqual(unequip)
  for (const invalid of [
    { ...equip, bagSlot: 24 },
    { ...equip, bagSlot: -1 },
    { ...equip, slot: 'head' },
    { ...equip, requestEpoch: '' },
    { ...equip, itemInstanceId: '' },
    { ...equip, protocolVersion: PROTOCOL_VERSION - 1 },
    { ...equip, currency: 25 },
    { ...equip, characterId: 'other' },
    { ...equip, kind: 'unequip' },
  ])
    expect(parseEquipmentRequest(invalid)).toBeUndefined()
})

test('validates the private snapshot capacity, quantities, purse and unique equipment locations', () => {
  expect(parseOwnerInventory(snapshot)).toEqual(snapshot)
  for (const invalid of [
    { ...snapshot, bag: [] },
    { ...snapshot, bag: Array(bagSlotCount) },
    { ...snapshot, currency: currencyLimit + 1 },
    { ...snapshot, bag: snapshot.bag.with(0, snapshot.equipment.weapon) },
    { ...snapshot, bag: snapshot.bag.with(0, { itemDefinitionId: 'hp_potion', quantity: 100 }) },
    { ...snapshot, equipment: { ...snapshot.equipment, weapon: { ...snapshot.equipment.weapon, quantity: 2 } } },
    { ...snapshot, result: { requestId: 4, code: 'UNKNOWN' } },
  ])
    expect(parseOwnerInventory(invalid)).toBeUndefined()
})
