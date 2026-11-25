import {
  bagSlotCount,
  currencyLimit,
  equipmentSlots,
  isNonNegativeSafeInteger,
  type BagItem,
  type EquipmentOperation,
  type Inventory,
  type InventoryError,
  type ItemDefinitionId,
  type ItemInstanceId,
  type ItemMetadata,
  type NonNegativeSafeInteger,
} from '@viesma/domain'
import { starterInventory, type ItemDefinition } from '@viesma/game-data'

export interface InventoryGrant {
  readonly itemDefinitionId: ItemDefinitionId
  readonly quantity: number
  readonly metadata?: unknown
  readonly itemInstanceId?: ItemInstanceId
}

type InventoryResult = { readonly inventory: Inventory } | { readonly code: InventoryError }

function parseMetadata(value: unknown): ItemMetadata | undefined {
  if (value === undefined) return Object.freeze({})
  if (typeof value !== 'object' || value === null) return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length > 16) return undefined
  const entries: [string, ItemMetadata[string]][] = []
  for (const key of keys) {
    if (typeof key !== 'string' || key.length < 1 || key.length > 64) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
    const field: unknown = descriptor.value
    if (
      field !== null &&
      typeof field !== 'boolean' &&
      !(typeof field === 'string' && field.length <= 256) &&
      !(typeof field === 'number' && Number.isSafeInteger(field))
    )
      return undefined
    entries.push([key, field])
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => (left < right ? -1 : Number(left > right)))))
}

export function createStarterInventory(items: readonly ItemDefinition[], weaponInstanceId: ItemInstanceId): Inventory {
  let inventory: Inventory = {
    bag: Array.from({ length: bagSlotCount }, () => null),
    equipment: { weapon: null, armor: null, accessory: null },
    currency: 0 as NonNegativeSafeInteger,
  }
  const id = (name: string) => {
    const item = items.find(({ id }) => id === name)
    if (!item) throw new RangeError(`Missing starter item: ${name}`)
    return item.id
  }
  for (const stack of starterInventory.bag) {
    const packed = insertInventory(inventory, { itemDefinitionId: id(stack.id), quantity: stack.quantity }, items)
    if ('code' in packed) throw new RangeError('Invalid starter stack')
    inventory = packed.inventory
  }
  const weapon = insertInventory(
    inventory,
    { itemDefinitionId: id(starterInventory.weapon), quantity: 1, itemInstanceId: weaponInstanceId },
    items
  )
  if ('code' in weapon) throw new RangeError('Invalid starter weapon')
  const equipped = changeEquipment(
    weapon.inventory,
    { kind: 'equip', bagSlot: starterInventory.bag.length, slot: 'weapon', itemInstanceId: weaponInstanceId },
    1,
    items
  )
  if ('code' in equipped) throw new RangeError('Invalid starter equipment')
  return equipped.inventory
}

export function parseInventoryGrant(grant: InventoryGrant) {
  const { itemDefinitionId, quantity, itemInstanceId } = grant
  const metadata = parseMetadata(grant.metadata)
  if (!metadata || !isNonNegativeSafeInteger(quantity) || quantity === 0) return undefined
  if (typeof itemDefinitionId !== 'string' || itemDefinitionId.length === 0 || itemDefinitionId.length > 64) return undefined
  if (itemInstanceId !== undefined && (typeof itemInstanceId !== 'string' || itemInstanceId.length === 0 || itemInstanceId.length > 64))
    return undefined
  return { itemDefinitionId, quantity, metadata, ...(itemInstanceId !== undefined && { itemInstanceId }) }
}

export function equipmentInstances(inventory: Inventory) {
  return [...inventory.bag, ...equipmentSlots.map((slot) => inventory.equipment[slot])].filter((item) => item?.kind === 'equipment')
}

export function insertInventory(inventory: Inventory, grant: InventoryGrant, items: readonly ItemDefinition[]): InventoryResult {
  const normalized = parseInventoryGrant(grant)
  if (!normalized) return { code: 'INVALID_ITEM' }
  const { itemDefinitionId, itemInstanceId, quantity, metadata } = normalized
  const definition = items.find(({ id }) => id === itemDefinitionId)
  if (!definition) return { code: 'INVALID_ITEM' }

  const emptySlots: number[] = []
  const fills: { slot: number; item: BagItem }[] = []
  let remaining: number = quantity
  const metadataKeys = Object.keys(metadata)
  const { maxStack } = definition
  if (definition.kind === 'equipment') {
    if (
      quantity !== 1 ||
      itemInstanceId === undefined ||
      equipmentInstances(inventory).some((item) => item.itemInstanceId === itemInstanceId)
    )
      return { code: 'INVALID_ITEM' }
  } else if (itemInstanceId !== undefined) return { code: 'INVALID_ITEM' }

  for (const [slot, item] of inventory.bag.entries()) {
    if (item === null) {
      emptySlots.push(slot)
    } else if (
      remaining > 0 &&
      definition.kind !== 'equipment' &&
      item.kind === 'stack' &&
      item.itemDefinitionId === itemDefinitionId &&
      item.quantity < maxStack &&
      Object.keys(item.metadata).length === metadataKeys.length &&
      metadataKeys.every((key) => Object.hasOwn(item.metadata, key) && item.metadata[key] === metadata[key])
    ) {
      const added = Math.min(maxStack - item.quantity, remaining)
      remaining -= added
      fills.push({ slot, item: { ...item, quantity: (item.quantity + added) as NonNegativeSafeInteger } })
    }
  }

  if (remaining > emptySlots.length * maxStack) return { code: 'BAG_FULL' }
  const bag = [...inventory.bag]
  for (const { slot, item } of fills) bag[slot] = item
  for (const slot of emptySlots) {
    if (remaining === 0) break
    const packed = Math.min(remaining, maxStack) as NonNegativeSafeInteger
    remaining -= packed
    bag[slot] =
      definition.kind === 'equipment' && itemInstanceId !== undefined
        ? { kind: 'equipment', itemDefinitionId, itemInstanceId, quantity: 1, metadata }
        : { kind: 'stack', itemDefinitionId, quantity: packed, metadata }
  }
  return { inventory: { ...inventory, bag } }
}

export function changeEquipment(
  inventory: Inventory,
  operation: EquipmentOperation,
  level: number,
  items: readonly ItemDefinition[]
): InventoryResult {
  const { slot, itemInstanceId } = operation
  if (!equipmentSlots.includes(slot)) return { code: 'WRONG_SLOT' }
  const equipped = inventory.equipment[slot]
  const bag = [...inventory.bag]
  if (operation.kind === 'unequip') {
    if (!equipped || equipped.itemInstanceId !== itemInstanceId) return { code: 'SOURCE_CHANGED' }
    const empty = bag.indexOf(null)
    if (empty < 0) return { code: 'BAG_FULL' }
    bag[empty] = equipped
    return { inventory: { ...inventory, bag, equipment: { ...inventory.equipment, [slot]: null } } }
  }
  const item = bag[operation.bagSlot]
  if (item?.kind !== 'equipment' || item.itemInstanceId !== itemInstanceId) return { code: 'SOURCE_CHANGED' }
  const definition = items.find(({ id }) => id === item.itemDefinitionId)
  if (definition?.kind !== 'equipment' || definition.slot !== slot) return { code: 'WRONG_SLOT' }
  // 已驗證的 MVP 裝備定義皆適用唯一職業 Beginner。
  if (definition.requiredLevel > level) return { code: 'LEVEL_REQUIRED' }
  bag[operation.bagSlot] = equipped
  return { inventory: { ...inventory, bag, equipment: { ...inventory.equipment, [slot]: item } } }
}

export function isValidInventory(inventory: Inventory, items: readonly ItemDefinition[]): boolean {
  if (inventory.bag.length !== bagSlotCount || !isNonNegativeSafeInteger(inventory.currency) || inventory.currency > currencyLimit)
    return false
  if (Reflect.ownKeys(inventory.equipment).length !== equipmentSlots.length) return false
  function isValidItem(item: BagItem, slot?: EquipmentOperation['slot']): boolean {
    const definition = items.find(({ id }) => id === item.itemDefinitionId)
    if (!definition || !parseMetadata(item.metadata)) return false
    if (item.kind === 'stack') {
      return (
        slot === undefined &&
        definition.kind !== 'equipment' &&
        isNonNegativeSafeInteger(item.quantity) &&
        item.quantity > 0 &&
        item.quantity <= definition.maxStack
      )
    }
    return (
      item.kind === 'equipment' &&
      definition.kind === 'equipment' &&
      item.quantity === 1 &&
      (slot === undefined || definition.slot === slot) &&
      typeof item.itemInstanceId === 'string' &&
      item.itemInstanceId.length > 0 &&
      item.itemInstanceId.length <= 64
    )
  }
  for (const item of inventory.bag) if (item !== null && (!item || !isValidItem(item))) return false
  return equipmentSlots.every((slot) => {
    const item = inventory.equipment[slot]
    return item === null || (item?.kind === 'equipment' && isValidItem(item, slot))
  })
}

export function changeCurrency(inventory: Inventory, delta: number): InventoryResult {
  const currency = inventory.currency + delta
  if (!Number.isSafeInteger(delta) || !isNonNegativeSafeInteger(currency) || currency > currencyLimit) return { code: 'CURRENCY_LIMIT' }
  return { inventory: currency === inventory.currency ? inventory : { ...inventory, currency } }
}
