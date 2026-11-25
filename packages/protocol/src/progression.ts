import { attributeNames, isNonNegativeSafeInteger, type Attributes, type DerivedCombatStats } from '@viesma/domain'
import { PROTOCOL_VERSION } from './join-version.js'
import { isWireId, parseMapRoomJoin, type MapRoomJoin } from './map-room.js'

export interface CharacterRequestHeader extends Omit<MapRoomJoin, 'characterId'> {
  readonly protocolVersion: number
  readonly requestId: number
  readonly expectedCharacterVersion: number
  readonly requestEpoch?: string
}

export interface AllocateApRequest extends CharacterRequestHeader {
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
export const isApResultCode = (value: unknown): value is ApResultCode => apResultCodes.some((code) => code === value)

export interface OwnerProgression extends MapRoomJoin {
  readonly protocolVersion: number
  readonly characterVersion: number
  readonly level: number
  readonly expWithinLevel: number
  readonly nextLevelExp: number | null
  readonly unspentAp: number
  readonly baseAttributes: Attributes
  readonly stats: DerivedCombatStats
  readonly reward?: {
    readonly sequence: number
    readonly experience: number
    readonly levelsGained: number
    readonly lootCount: number
  }
  readonly result?: { readonly requestId: number; readonly requestEpoch?: string; readonly code: ApResultCode }
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype === Object.prototype || prototype === null) return value as Record<string, unknown>
}

function parseAttributes(value: unknown): Attributes | undefined {
  const fields = readRecord(value)
  if (!fields || Reflect.ownKeys(fields).length !== attributeNames.length || !attributeNames.every((name) => Object.hasOwn(fields, name)))
    return undefined
  const { str, dex, int, luk } = fields
  if (isNonNegativeSafeInteger(str) && isNonNegativeSafeInteger(dex) && isNonNegativeSafeInteger(int) && isNonNegativeSafeInteger(luk))
    return { str, dex, int, luk }
}

export function readCharacterRequestId(value: unknown): number | undefined {
  const requestId = readRecord(value)?.requestId
  if (isNonNegativeSafeInteger(requestId)) return requestId
}

const requestFields = ['protocolVersion', 'requestId', 'connectionEpoch', 'mapEpoch', 'expectedCharacterVersion'] as const

export function parseCharacterRequestHeader(
  fields: Record<string, unknown> | undefined,
  extra: readonly string[]
): CharacterRequestHeader | undefined {
  if (!fields) return undefined
  const hasOrigin = Object.hasOwn(fields, 'requestEpoch')
  const keys = hasOrigin ? [...requestFields, 'requestEpoch', ...extra] : [...requestFields, ...extra]
  if (Reflect.ownKeys(fields).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))) return undefined
  const { protocolVersion, requestId, connectionEpoch, mapEpoch, expectedCharacterVersion, requestEpoch } = fields
  if (
    protocolVersion !== PROTOCOL_VERSION ||
    !isWireId(connectionEpoch) ||
    !isNonNegativeSafeInteger(requestId) ||
    !isNonNegativeSafeInteger(mapEpoch) ||
    !isNonNegativeSafeInteger(expectedCharacterVersion) ||
    (hasOrigin && !isWireId(requestEpoch))
  )
    return undefined
  return {
    protocolVersion,
    requestId,
    connectionEpoch,
    mapEpoch,
    expectedCharacterVersion,
    ...(typeof requestEpoch === 'string' && { requestEpoch }),
  }
}

export function parseAllocateAp(value: unknown): AllocateApRequest | undefined {
  const fields = readRecord(value)
  const header = parseCharacterRequestHeader(fields, ['deltas'])
  const deltas = parseAttributes(fields?.deltas)
  if (header && deltas) return { ...header, deltas }
}

function parseStats(value: unknown): DerivedCombatStats | undefined {
  const fields = readRecord(value)
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
  const fields = readRecord(value)
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
  if (Object.hasOwn(fields, 'reward')) {
    const reward = readRecord(fields.reward)
    const { sequence, experience, levelsGained, lootCount } = reward ?? {}
    if (
      Object.hasOwn(fields, 'result') ||
      !isNonNegativeSafeInteger(sequence) ||
      !isNonNegativeSafeInteger(experience) ||
      !isNonNegativeSafeInteger(levelsGained) ||
      !isNonNegativeSafeInteger(lootCount) ||
      sequence === 0 ||
      levelsGained > level - 1 ||
      (experience === 0 && (levelsGained !== 0 || lootCount === 0))
    )
      return undefined
    return { ...snapshot, reward: { sequence, experience, levelsGained, lootCount } }
  }
  if (!Object.hasOwn(fields, 'result')) return snapshot
  const result = readRecord(fields.result)
  const { requestId, requestEpoch, code } = result ?? {}
  if (isNonNegativeSafeInteger(requestId) && (requestEpoch === undefined || isWireId(requestEpoch)) && isApResultCode(code))
    return { ...snapshot, result: { requestId, code, ...(requestEpoch !== undefined && { requestEpoch }) } }
}
