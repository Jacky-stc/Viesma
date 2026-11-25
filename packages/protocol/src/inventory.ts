import {
  bagSlotCount,
  currencyLimit,
  equipmentSlots,
  isNonNegativeSafeInteger,
  stackableItemLimit,
  type EquipmentOperation,
  type EquipmentSlot,
  type ItemInstanceId,
} from '@viesma/domain'
import { PROTOCOL_VERSION } from './join-version.js'
import { isWireId, parseMapRoomJoin, type MapRoomJoin } from './map-room.js'
import { parseCharacterRequestHeader, readRecord, type CharacterRequestHeader } from './progression.js'

export type EquipmentRequest = CharacterRequestHeader & EquipmentOperation

const equipmentResultCodes = [
  'CONFIRMED',
  'INVALID_ITEM',
  'BAG_FULL',
  'SOURCE_CHANGED',
  'WRONG_SLOT',
  'LEVEL_REQUIRED',
  'STALE_BINDING',
  'STALE_VERSION',
  'UNAVAILABLE',
  'STALE_REQUEST',
  'REQUEST_CONFLICT',
  'BUSY',
] as const
export type EquipmentResultCode = (typeof equipmentResultCodes)[number]
export const isEquipmentResultCode = (value: unknown): value is EquipmentResultCode => equipmentResultCodes.some((code) => code === value)

export interface InventoryItemView {
  readonly itemDefinitionId: string
  readonly quantity: number
  readonly itemInstanceId?: ItemInstanceId
}

export interface OwnerInventory extends MapRoomJoin {
  readonly protocolVersion: number
  readonly characterVersion: number
  readonly bag: readonly (InventoryItemView | null)[]
  readonly equipment: Readonly<Record<EquipmentSlot, InventoryItemView | null>>
  readonly currency: number
  readonly result?: { readonly requestId: number; readonly requestEpoch?: string; readonly code: EquipmentResultCode }
}

export function parseEquipmentRequest(value: unknown): EquipmentRequest | undefined {
  const fields = readRecord(value)
  const header = parseCharacterRequestHeader(
    fields,
    fields?.kind === 'equip' ? ['kind', 'slot', 'itemInstanceId', 'bagSlot'] : ['kind', 'slot', 'itemInstanceId']
  )
  if (!header || !fields) return undefined
  const { kind, bagSlot, itemInstanceId } = fields
  const slot = equipmentSlots.find((slot) => slot === fields.slot)
  if (!slot || !isWireId(itemInstanceId)) return undefined
  const source = { slot, itemInstanceId: itemInstanceId as ItemInstanceId }
  if (kind === 'unequip') return { ...header, ...source, kind }
  if (kind === 'equip' && isNonNegativeSafeInteger(bagSlot) && bagSlot < bagSlotCount) return { ...header, ...source, kind, bagSlot }
}

export function parseOwnerInventory(value: unknown): OwnerInventory | undefined {
  const fields = readRecord(value)
  const binding = parseMapRoomJoin(fields)
  if (!fields || !binding) return undefined
  const { protocolVersion, characterVersion, bag, currency } = fields
  const equipment = readRecord(fields.equipment)
  if (
    protocolVersion !== PROTOCOL_VERSION ||
    !isNonNegativeSafeInteger(characterVersion) ||
    !Array.isArray(bag) ||
    bag.length !== bagSlotCount ||
    !equipment ||
    Reflect.ownKeys(equipment).length !== equipmentSlots.length ||
    !isNonNegativeSafeInteger(currency) ||
    currency > currencyLimit
  )
    return undefined

  const seen = new Set<string>()
  function readItem(value: unknown, equipped = false): InventoryItemView | null | undefined {
    if (value === null) return null
    const item = readRecord(value)
    if (!item) return undefined
    const { itemDefinitionId, quantity, itemInstanceId } = item
    if (!isWireId(itemDefinitionId) || !isNonNegativeSafeInteger(quantity) || quantity < 1 || quantity > stackableItemLimit)
      return undefined
    if (itemInstanceId === undefined && !equipped) return { itemDefinitionId, quantity }
    if (!isWireId(itemInstanceId) || quantity !== 1 || seen.has(itemInstanceId)) return undefined
    seen.add(itemInstanceId)
    return { itemDefinitionId, quantity, itemInstanceId: itemInstanceId as ItemInstanceId }
  }
  const slots = Array.from(bag as readonly unknown[], (item) => readItem(item))
  const weapon = readItem(equipment.weapon, true)
  const armor = readItem(equipment.armor, true)
  const accessory = readItem(equipment.accessory, true)
  if (slots.some((item) => item === undefined) || weapon === undefined || armor === undefined || accessory === undefined) return undefined
  const snapshot = {
    ...binding,
    protocolVersion,
    characterVersion,
    currency,
    bag: slots.map((item) => item ?? null),
    equipment: { weapon, armor, accessory },
  }
  if (!Object.hasOwn(fields, 'result')) return snapshot
  const result = readRecord(fields.result)
  const { requestId, requestEpoch, code } = result ?? {}
  if (isNonNegativeSafeInteger(requestId) && (requestEpoch === undefined || isWireId(requestEpoch)) && isEquipmentResultCode(code)) {
    return { ...snapshot, result: { requestId, code, ...(requestEpoch !== undefined && { requestEpoch }) } }
  }
}
