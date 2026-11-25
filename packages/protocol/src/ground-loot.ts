import { bagSlotCount, currencyLimit, isNonNegativeSafeInteger, type ItemDefinitionId, type LootId, type WorldPoint } from '@viesma/domain'
import { PROTOCOL_VERSION } from './join-version.js'
import { isWireId, parseMapRoomJoin, type MapRoomJoin } from './map-room.js'
import { parseCharacterRequestHeader, readRecord, type CharacterRequestHeader } from './progression.js'

export type GroundLootOperation =
  | { readonly kind: 'pickup'; readonly lootId: LootId }
  | { readonly kind: 'consume'; readonly bagSlot: number; readonly itemDefinitionId: ItemDefinitionId }

export type GroundLootRequest = CharacterRequestHeader & GroundLootOperation

export interface PrivateLootBinding extends MapRoomJoin {
  readonly protocolVersion: number
  readonly mapInstanceId: string
}

export interface GroundLootView {
  readonly lootId: LootId
  readonly position: WorldPoint
  readonly expiresAtUtcMilliseconds: number
  readonly content:
    | { readonly kind: 'currency'; readonly amount: number }
    | { readonly kind: 'item'; readonly itemDefinitionId: ItemDefinitionId; readonly quantity: number }
}

export type OwnerGroundLoot = PrivateLootBinding & { readonly privateRevision: number } & (
    | { readonly kind: 'snapshot'; readonly loot: readonly GroundLootView[] }
    | {
        readonly kind: 'delta'
        readonly baseRevision: number
        readonly added: readonly GroundLootView[]
        readonly removed: readonly LootId[]
      }
  )

const lootResultCodes = [
  'PENDING',
  'CONFIRMED',
  'CONSUMED_NO_EFFECT',
  'CONSUMED_DEAD',
  'INVALID_ITEM',
  'BAG_FULL',
  'SOURCE_CHANGED',
  'CURRENCY_LIMIT',
  'STALE_BINDING',
  'STALE_VERSION',
  'UNAVAILABLE',
  'STALE_REQUEST',
  'REQUEST_CONFLICT',
  'BUSY',
  'LOOT_UNAVAILABLE',
  'LOOT_EXPIRED',
  'TOO_FAR',
  'RESOURCE_FULL',
  'COOLDOWN',
] as const
export type LootResultCode = (typeof lootResultCodes)[number]
export const isLootResultCode = (value: unknown): value is LootResultCode => lootResultCodes.some((code) => code === value)

export interface OwnerLootCommandResult extends PrivateLootBinding {
  readonly kind: GroundLootOperation['kind']
  readonly requestId: number
  readonly requestEpoch: string
  readonly code: LootResultCode
}

const isLootId = (value: unknown): value is LootId =>
  typeof value === 'string' && value.startsWith('loot:') && value.length > 5 && value.length <= 512

export function parseGroundLootRequest(value: unknown, kind: GroundLootOperation['kind']): GroundLootRequest | undefined {
  const fields = readRecord(value)
  const header = parseCharacterRequestHeader(fields, kind === 'pickup' ? ['lootId'] : ['bagSlot', 'itemDefinitionId'])
  if (!fields || !header) return undefined
  const { lootId, bagSlot, itemDefinitionId } = fields
  if (kind === 'pickup' && isLootId(lootId)) return { ...header, kind, lootId }
  if (kind === 'consume' && isNonNegativeSafeInteger(bagSlot) && bagSlot < bagSlotCount && isWireId(itemDefinitionId))
    return { ...header, kind, bagSlot, itemDefinitionId: itemDefinitionId as ItemDefinitionId }
}

function parsePrivateBinding(fields: Record<string, unknown> | undefined): PrivateLootBinding | undefined {
  const binding = parseMapRoomJoin(fields)
  if (binding && fields?.protocolVersion === PROTOCOL_VERSION && isWireId(fields.mapInstanceId))
    return { ...binding, protocolVersion: PROTOCOL_VERSION, mapInstanceId: fields.mapInstanceId }
}

export function parseGroundLootRefresh(value: unknown): PrivateLootBinding | undefined {
  const fields = readRecord(value)
  if (fields && Reflect.ownKeys(fields).length === 5) return parsePrivateBinding(fields)
}

function parseView(value: unknown): GroundLootView | undefined {
  const fields = readRecord(value)
  const position = readRecord(fields?.position)
  const content = readRecord(fields?.content)
  if (!fields || !position || !content) return undefined
  const { lootId, expiresAtUtcMilliseconds } = fields
  const { x, y } = position
  if (
    !isLootId(lootId) ||
    !isNonNegativeSafeInteger(expiresAtUtcMilliseconds) ||
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  )
    return undefined
  const common = { lootId, expiresAtUtcMilliseconds, position: { x, y } }
  const { kind, amount, quantity, itemDefinitionId } = content
  if (kind === 'currency' && isNonNegativeSafeInteger(amount) && amount > 0 && amount <= currencyLimit)
    return { ...common, content: { kind, amount } }
  if (kind === 'item' && isWireId(itemDefinitionId) && isNonNegativeSafeInteger(quantity) && quantity > 0)
    return { ...common, content: { kind, itemDefinitionId: itemDefinitionId as ItemDefinitionId, quantity } }
}

function parseList(value: unknown): GroundLootView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: GroundLootView[] = []
  const seen = new Set<LootId>()
  for (const raw of value as unknown[]) {
    const item = parseView(raw)
    if (!item || seen.has(item.lootId)) return undefined
    seen.add(item.lootId)
    items.push(item)
  }
  return items
}

export function parseOwnerGroundLoot(value: unknown): OwnerGroundLoot | undefined {
  const fields = readRecord(value)
  const binding = parsePrivateBinding(fields)
  if (!fields || !binding || !isNonNegativeSafeInteger(fields.privateRevision)) return undefined
  const { kind, privateRevision, baseRevision } = fields
  if (kind === 'snapshot') {
    const loot = parseList(fields.loot)
    if (loot) return { ...binding, kind, privateRevision, loot }
  }
  if (kind === 'delta' && isNonNegativeSafeInteger(baseRevision) && baseRevision < privateRevision && Array.isArray(fields.removed)) {
    const added = parseList(fields.added)
    const removed = Array.from(fields.removed as unknown[])
    if (
      added &&
      removed.every(isLootId) &&
      new Set(removed).size === removed.length &&
      added.every(({ lootId }) => !removed.includes(lootId))
    )
      return { ...binding, kind, privateRevision, baseRevision, added, removed }
  }
}

export function parseOwnerLootCommandResult(value: unknown): OwnerLootCommandResult | undefined {
  const fields = readRecord(value)
  const binding = parsePrivateBinding(fields)
  if (!fields || !binding) return undefined
  const { kind, requestId, requestEpoch, code } = fields
  if ((kind === 'pickup' || kind === 'consume') && isNonNegativeSafeInteger(requestId) && isWireId(requestEpoch) && isLootResultCode(code))
    return { ...binding, kind, requestId, requestEpoch, code }
}
