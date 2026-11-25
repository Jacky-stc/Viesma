import { bagSlotCount, currencyLimit } from '@viesma/domain'
import { loadGrayboxGameData } from '@viesma/game-data'
import { expect, test } from 'vitest'
import { changeCurrency, changeEquipment, createStarterInventory, insertInventory } from '../src/index.ts'

const { items } = loadGrayboxGameData()
const starter = () => createStarterInventory(items, 'starter')
const add = (inventory, itemDefinitionId, quantity, extra = {}) =>
  insertInventory(inventory, { itemDefinitionId, quantity, ...extra }, items)
const move = (inventory, kind, slot, itemInstanceId, bagSlot, level = 1) =>
  changeEquipment(inventory, { kind, slot, itemInstanceId, bagSlot }, level, items)
const potions = (inventory) => inventory.bag.filter((item) => item?.itemDefinitionId === 'hp_potion').map((item) => item.quantity)

test('has exactly 24 slots with two fixed starter stacks, one equipped sword and a separate zero purse', () => {
  const state = starter()
  expect(state).toEqual({
    bag: [
      { kind: 'stack', itemDefinitionId: 'hp_potion', quantity: 5, metadata: {} },
      { kind: 'stack', itemDefinitionId: 'mp_potion', quantity: 3, metadata: {} },
      ...Array(bagSlotCount - 2).fill(null),
    ],
    equipment: {
      weapon: { kind: 'equipment', itemDefinitionId: 'training_sword', itemInstanceId: 'starter', quantity: 1, metadata: {} },
      armor: null,
      accessory: null,
    },
    currency: 0,
  })
})

test('fills partial stacks before empty slots, including 1, 98, 99 and multiple overflow stacks', () => {
  const first = add(starter(), 'hp_potion', 93).inventory
  expect(potions(first)).toEqual([98])
  const second = add(first, 'hp_potion', 1).inventory
  expect(potions(second)).toEqual([99])
  const third = add(second, 'hp_potion', 199).inventory
  expect(potions(third)).toEqual([99, 99, 99, 1])
  const gap = { ...third, bag: third.bag.with(1, null).with(2, { ...third.bag[2], quantity: 98 }) }
  const packed = add(gap, 'hp_potion', 200).inventory
  expect(packed.bag.map((item) => item?.quantity)).toEqual([99, 99, 99, 99, 99, 2, ...Array(18).fill(undefined)])
})

test('matches exact metadata by field and value without requiring equal key order', () => {
  const before = add(starter(), 'hp_potion', 98, { metadata: { region: 'east', fragile: true } }).inventory
  const same = add(before, 'hp_potion', 1, { metadata: { fragile: true, region: 'east' } }).inventory
  const different = add(same, 'hp_potion', 1, { metadata: { fragile: false, region: 'east' } }).inventory
  const otherKey = add(different, 'hp_potion', 1, { metadata: { fragile: true, origin: 'east' } }).inventory
  expect(potions(otherKey)).toEqual([5, 99, 1, 1])
  expect(add(otherKey, 'mp_potion', 1, { metadata: { fragile: true, region: 'east' } }).inventory.bag[5].itemDefinitionId).toBe('mp_potion')
  const material = items.find(({ kind }) => kind === 'material')
  expect(add(otherKey, material.id, 100).inventory.bag.slice(5, 7)).toMatchObject([
    { itemDefinitionId: material.id, quantity: 99 },
    { itemDefinitionId: material.id, quantity: 1 },
  ])
})

test.each([0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])('rejects invalid insertion quantity %s', (quantity) => {
  expect(add(starter(), 'hp_potion', quantity)).toEqual({ code: 'INVALID_ITEM' })
})

test('rejects unknown definitions and invalid metadata without consulting accessors', () => {
  const state = starter()
  expect(add(state, 'unknown', 1)).toEqual({ code: 'INVALID_ITEM' })
  for (const metadata of [
    null,
    [],
    { nested: {} },
    { unsafe: Number.MAX_SAFE_INTEGER + 1 },
    { empty: undefined },
    { '': 1 },
    { large: 'a'.repeat(257) },
    { [Symbol('invalid')]: 1 },
    {
      get field() {
        throw Error('cannot read accessor')
      },
    },
  ]) {
    expect(add(state, 'hp_potion', 1, { metadata })).toEqual({ code: 'INVALID_ITEM' })
  }
})

test('rejects a full-bag insertion with a partial fit and leaves the original stack intact', () => {
  const initial = starter()
  const full = add(initial, 'mp_potion', 22 * 99 + 96).inventory
  expect(full.bag.every(Boolean)).toBe(true)
  expect(add(full, 'hp_potion', 95)).toEqual({ code: 'BAG_FULL' })
  expect(potions(full)).toEqual([5])
  expect(full.bag).toHaveLength(24)
  expect(potions(add(full, 'hp_potion', 94).inventory)).toEqual([99])
})

test('equipment quantity is one and duplicate IDs in bag or equipment are refused', () => {
  const initial = starter()
  expect(add(initial, 'training_sword', 1, { itemInstanceId: 'starter' })).toEqual({ code: 'INVALID_ITEM' })
  expect(add(initial, 'training_sword', 2, { itemInstanceId: 'new' })).toEqual({ code: 'INVALID_ITEM' })
  expect(add(initial, 'training_sword', 1)).toEqual({ code: 'INVALID_ITEM' })
  expect(add(initial, 'hp_potion', 1, { itemInstanceId: 'bad' })).toEqual({ code: 'INVALID_ITEM' })
  const added = add(initial, 'training_sword', 1, { itemInstanceId: 'new' }).inventory
  expect(add(added, 'armor_tier_1', 1, { itemInstanceId: 'new' })).toEqual({ code: 'INVALID_ITEM' })
  const separate = add(added, 'training_sword', 1, { itemInstanceId: 'other' }).inventory
  expect(separate.bag.slice(2, 4).map(({ itemInstanceId, quantity }) => [itemInstanceId, quantity])).toEqual([
    ['new', 1],
    ['other', 1],
  ])
})

test('equips into an empty slot, rejects wrong slot, level and source identity, and unequips to the first empty slot', () => {
  const initial = add(starter(), 'armor_tier_5', 1, { itemInstanceId: 'new' }).inventory
  expect(move(initial, 'equip', 'weapon', 'new', 2)).toEqual({ code: 'WRONG_SLOT' })
  expect(move(initial, 'equip', 'armor', 'new', 2)).toEqual({ code: 'LEVEL_REQUIRED' })
  expect(move(initial, 'equip', 'armor', 'stale', 2, 5)).toEqual({ code: 'SOURCE_CHANGED' })
  const equipped = move(initial, 'equip', 'armor', 'new', 2, 5).inventory
  expect(equipped.equipment.armor.itemInstanceId).toBe('new')
  expect(equipped.bag[2]).toBeNull()
  expect(move(equipped, 'unequip', 'armor', 'stale')).toEqual({ code: 'SOURCE_CHANGED' })
  expect(move(equipped, 'unequip', 'armor', 'new').inventory).toEqual(initial)
})

test('swaps equipment with a full bag and rejects unequipping until there is capacity', () => {
  const secondSword = add(starter(), 'training_sword', 1, { itemInstanceId: 'second' }).inventory
  const full = add(secondSword, 'mp_potion', 21 * 99 + 96).inventory
  const swapped = move(full, 'equip', 'weapon', 'second', 2).inventory
  expect(swapped.bag[2].itemInstanceId).toBe('starter')
  expect(swapped.equipment.weapon.itemInstanceId).toBe('second')
  expect(swapped.bag.filter(Boolean)).toHaveLength(24)
  expect(move(swapped, 'unequip', 'weapon', 'second')).toEqual({ code: 'BAG_FULL' })
  expect(swapped.equipment.weapon.itemInstanceId).toBe('second')
})

test('purse accepts exactly its integer bounds without changing slots', () => {
  const initial = starter()
  const limit = changeCurrency(initial, currencyLimit).inventory
  expect(limit.currency).toBe(2_147_483_647)
  expect(limit.bag).toBe(initial.bag)
  expect(changeCurrency(limit, -currencyLimit).inventory).toEqual(initial)
  for (const delta of [-1, 0.5, currencyLimit + 1, Number.MAX_SAFE_INTEGER + 1]) {
    expect(changeCurrency(initial, delta)).toEqual({ code: 'CURRENCY_LIMIT' })
  }
  expect(changeCurrency(limit, 1)).toEqual({ code: 'CURRENCY_LIMIT' })
})
