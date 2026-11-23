import { isNonNegativeSafeInteger, type MoveX, type NonNegativeSafeInteger, type WorldPoint } from '@viesma/domain'
import { PROTOCOL_VERSION } from './join-version.js'

/** 接收端先驗證 wire payload，再轉成 simulation command。 */
export interface InputFrame {
  readonly protocolVersion: number
  readonly connectionEpoch: string
  readonly mapEpoch: number
  readonly seq: number
  readonly moveX: MoveX
  readonly jumpPressed: boolean
  readonly attackPressed: boolean
}

export interface MapRoomJoin {
  readonly characterId: string
  readonly connectionEpoch: string
  readonly mapEpoch: number
}

export function parseMapRoomJoin(value: unknown): MapRoomJoin | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { characterId, connectionEpoch, mapEpoch } = value as Partial<Record<keyof MapRoomJoin, unknown>>
  if (!isWireId(characterId) || !isWireId(connectionEpoch) || !isNonNegativeSafeInteger(mapEpoch)) return undefined
  return { characterId, connectionEpoch, mapEpoch }
}

export function isWireId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}

export interface PublicRoomHeader {
  readonly mapInstanceId: string
  readonly serverTick: number
}

export interface PublicPlayer extends WorldPoint {
  readonly characterId: string
  readonly mapEpoch: number
  readonly lifeStartedTick: number
  readonly state: 'idle' | 'run' | 'jump' | 'fall' | 'attack' | 'hurt' | 'death'
  readonly facing: 'left' | 'right'
  readonly hp: number
  readonly maxHp: number
}

export interface PublicMonster extends WorldPoint {
  readonly monsterId: string
  readonly archetypeId: string
  readonly state: 'patrol'
  readonly facing: 'left' | 'right'
  readonly hp: number
  readonly maxHp: number
}

export interface PublicMapRoom extends PublicRoomHeader {
  readonly mapId: string
  readonly mapContentHash: string
  readonly players: readonly PublicPlayer[]
  readonly monsters: readonly PublicMonster[]
}

const inputFields = ['protocolVersion', 'connectionEpoch', 'mapEpoch', 'seq', 'moveX', 'jumpPressed', 'attackPressed'] as const

export function parseInputFrame(value: unknown): (InputFrame & { readonly seq: NonNegativeSafeInteger }) | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  if (Reflect.ownKeys(value).length !== inputFields.length || !inputFields.every((field) => Object.hasOwn(value, field))) return undefined
  const { protocolVersion, connectionEpoch, mapEpoch, seq, moveX, jumpPressed, attackPressed } = value as Record<string, unknown>
  if (
    protocolVersion !== PROTOCOL_VERSION ||
    !isWireId(connectionEpoch) ||
    !isNonNegativeSafeInteger(mapEpoch) ||
    !isNonNegativeSafeInteger(seq) ||
    (moveX !== -1 && moveX !== 0 && moveX !== 1) ||
    typeof jumpPressed !== 'boolean' ||
    typeof attackPressed !== 'boolean'
  )
    return undefined
  return { protocolVersion, connectionEpoch, mapEpoch, seq, moveX, jumpPressed, attackPressed }
}
