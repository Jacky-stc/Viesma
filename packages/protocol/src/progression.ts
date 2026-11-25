import { attributeNames, isNonNegativeSafeInteger, type Attributes, type DerivedCombatStats } from '@viesma/domain'
import { PROTOCOL_VERSION } from './join-version.js'
import { isWireId, parseMapRoomJoin, type MapRoomJoin } from './map-room.js'

export interface AllocateApRequest extends Omit<MapRoomJoin, 'characterId'> {
  readonly protocolVersion: number
  readonly requestId: number
  readonly expectedCharacterVersion: number
  readonly deltas: Attributes
}

const apResultCodes = [
  'CONFIRMED',
  'INVALID_ALLOCATION',
  'INSUFFICIENT_AP',
  'STALE_BINDING',
  'STALE_VERSION',
  'UNAVAILABLE',
  'STALE_REQUEST',
  'REQUEST_CONFLICT',
  'BUSY',
] as const

export type ApResultCode = (typeof apResultCodes)[number]

export interface OwnerProgression extends MapRoomJoin {
  readonly protocolVersion: number
  readonly characterVersion: number
  readonly level: number
  readonly expWithinLevel: number
  readonly nextLevelExp: number | null
  readonly unspentAp: number
  readonly baseAttributes: Attributes
  readonly stats: DerivedCombatStats
  readonly result?: { readonly requestId: number; readonly code: ApResultCode }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype === Object.prototype || prototype === null) return value as Record<string, unknown>
}

function parseAttributes(value: unknown): Attributes | undefined {
  const fields = record(value)
  if (!fields || Reflect.ownKeys(fields).length !== attributeNames.length || !attributeNames.every((name) => Object.hasOwn(fields, name)))
    return undefined
  const { str, dex, int, luk } = fields
  if (isNonNegativeSafeInteger(str) && isNonNegativeSafeInteger(dex) && isNonNegativeSafeInteger(int) && isNonNegativeSafeInteger(luk))
    return { str, dex, int, luk }
}

export function readApRequestId(value: unknown): number | undefined {
  const requestId = record(value)?.requestId
  if (isNonNegativeSafeInteger(requestId)) return requestId
}

const requestFields = ['protocolVersion', 'requestId', 'connectionEpoch', 'mapEpoch', 'expectedCharacterVersion', 'deltas'] as const

export function parseAllocateAp(value: unknown): AllocateApRequest | undefined {
  const fields = record(value)
  if (!fields || Reflect.ownKeys(fields).length !== requestFields.length || !requestFields.every((key) => Object.hasOwn(fields, key)))
    return undefined
  const { protocolVersion, requestId, connectionEpoch, mapEpoch, expectedCharacterVersion } = fields
  const deltas = parseAttributes(fields.deltas)
  if (
    protocolVersion !== PROTOCOL_VERSION ||
    !isWireId(connectionEpoch) ||
    !isNonNegativeSafeInteger(requestId) ||
    !isNonNegativeSafeInteger(mapEpoch) ||
    !isNonNegativeSafeInteger(expectedCharacterVersion) ||
    !deltas
  )
    return undefined
  return { protocolVersion, requestId, connectionEpoch, mapEpoch, expectedCharacterVersion, deltas }
}

function parseStats(value: unknown): DerivedCombatStats | undefined {
  const fields = record(value)
  if (!fields) return undefined
  const { maxHp, maxMp, attackPower, physicalDefense, magicDefense, criticalChanceBps, criticalMultiplierPercent } = fields
  if (
    !isNonNegativeSafeInteger(maxHp) ||
    maxHp === 0 ||
    !isNonNegativeSafeInteger(maxMp) ||
    maxMp === 0 ||
    !isNonNegativeSafeInteger(attackPower) ||
    attackPower === 0 ||
    !isNonNegativeSafeInteger(physicalDefense) ||
    !isNonNegativeSafeInteger(magicDefense) ||
    !isNonNegativeSafeInteger(criticalChanceBps) ||
    !isNonNegativeSafeInteger(criticalMultiplierPercent)
  )
    return undefined
  return { maxHp, maxMp, attackPower, physicalDefense, magicDefense, criticalChanceBps, criticalMultiplierPercent }
}

export function parseOwnerProgression(value: unknown): OwnerProgression | undefined {
  const fields = record(value)
  const binding = parseMapRoomJoin(fields)
  if (!fields || !binding) return undefined
  const { protocolVersion, characterVersion, level, expWithinLevel, nextLevelExp, unspentAp } = fields
  const baseAttributes = parseAttributes(fields.baseAttributes)
  const stats = parseStats(fields.stats)
  if (
    protocolVersion !== PROTOCOL_VERSION ||
    !isNonNegativeSafeInteger(characterVersion) ||
    !isNonNegativeSafeInteger(level) ||
    level === 0 ||
    !isNonNegativeSafeInteger(expWithinLevel) ||
    (nextLevelExp !== null && !isNonNegativeSafeInteger(nextLevelExp)) ||
    !isNonNegativeSafeInteger(unspentAp) ||
    !baseAttributes ||
    !stats
  )
    return undefined
  if (nextLevelExp === null ? expWithinLevel !== 0 : nextLevelExp <= expWithinLevel) return undefined
  const snapshot = { ...binding, protocolVersion, characterVersion, level, expWithinLevel, nextLevelExp, unspentAp, baseAttributes, stats }
  if (!Object.hasOwn(fields, 'result')) return snapshot
  const result = record(fields.result)
  const requestId = result?.requestId
  const code = apResultCodes.find((code) => code === result?.code)
  if (isNonNegativeSafeInteger(requestId) && code) return { ...snapshot, result: { requestId, code } }
}
