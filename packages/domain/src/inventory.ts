import type { CharacterAggregate } from './progression.js'
import type { ItemDefinitionId, ItemInstanceId, NonNegativeSafeInteger } from './types.js'

export const equipmentSlots = ['weapon', 'armor', 'accessory'] as const
export type EquipmentSlot = (typeof equipmentSlots)[number]

export const bagSlotCount = 24
export const currencyLimit = 2_147_483_647
export const stackableItemLimit = 99

export type ItemMetadata = Readonly<Record<string, string | number | boolean | null>>

interface InventoryItemFields {
  readonly itemDefinitionId: ItemDefinitionId
  readonly metadata: ItemMetadata
}

export interface ItemInstance extends InventoryItemFields {
  readonly kind: 'equipment'
  readonly itemInstanceId: ItemInstanceId
  readonly quantity: 1
}

export interface ItemStack extends InventoryItemFields {
  readonly kind: 'stack'
  readonly quantity: NonNegativeSafeInteger
}

export type BagItem = ItemInstance | ItemStack

export interface Inventory {
  readonly bag: readonly (BagItem | null)[]
  readonly equipment: Readonly<Record<EquipmentSlot, ItemInstance | null>>
  readonly currency: NonNegativeSafeInteger
}

export interface CharacterEconomy extends CharacterAggregate {
  readonly inventory: Inventory
}

export type EquipmentOperation =
  | { readonly kind: 'equip'; readonly bagSlot: number; readonly slot: EquipmentSlot; readonly itemInstanceId: ItemInstanceId }
  | { readonly kind: 'unequip'; readonly slot: EquipmentSlot; readonly itemInstanceId: ItemInstanceId }

export type CharacterCommandCode =
  | 'CONFIRMED'
  | 'INVALID_ALLOCATION'
  | 'INSUFFICIENT_AP'
  | 'STALE_BINDING'
  | 'STALE_VERSION'
  | 'UNAVAILABLE'
  | 'STALE_REQUEST'
  | 'REQUEST_CONFLICT'
  | 'BUSY'
  | InventoryError

export type InventoryError = 'INVALID_ITEM' | 'BAG_FULL' | 'SOURCE_CHANGED' | 'WRONG_SLOT' | 'LEVEL_REQUIRED' | 'CURRENCY_LIMIT'
