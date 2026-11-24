import { isNonNegativeSafeInteger } from '@viesma/domain'
import { isWireId, parseMapRoomJoin, type MapRoomJoin } from './map-room.js'

export type OnlineMapId = 'm1' | 'village'

export type MapAdmission =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'transfer'; readonly ticket: string; readonly reconnectToken: string }
  | { readonly kind: 'reconnect'; readonly reconnectToken: string }

export interface MapRoomSession extends MapRoomJoin {
  readonly reconnectToken: string
}

export interface PortalRequest {
  readonly requestId: number
  readonly mapEpoch: number
  readonly objectId: string
}

export interface TransferOffer {
  readonly requestId: number | null
  readonly roomId: string
  readonly mapId: OnlineMapId
  readonly mapEpoch: number
  readonly ticket: string
}

const failureCodes = ['PORTAL_UNAVAILABLE', 'MAP_SEAT_UNAVAILABLE', 'TRANSFER_EXPIRED', 'TRANSFER_FAILED', 'WORLD_TICK_BACKLOG'] as const

export interface TransferFailure {
  readonly requestId: number | null
  readonly code: (typeof failureCodes)[number]
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  return value as Record<string, unknown>
}

function fields(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  const payload = record(value)
  return payload && Reflect.ownKeys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key))
    ? payload
    : undefined
}

export function parseMapAdmission(value: unknown): MapAdmission | undefined {
  const payload = record(value)
  if (!payload) return undefined
  if (!Object.hasOwn(payload, 'ticket') && !Object.hasOwn(payload, 'reconnectToken')) return { kind: 'fresh' }
  const { reconnectToken, ticket } = payload
  if (!isWireId(reconnectToken)) return undefined
  if (!Object.hasOwn(payload, 'ticket')) return { kind: 'reconnect', reconnectToken }
  if (isWireId(ticket)) return { kind: 'transfer', ticket, reconnectToken }
}

export function parseMapRoomSession(value: unknown): MapRoomSession | undefined {
  const binding = parseMapRoomJoin(value)
  const reconnectToken = record(value)?.reconnectToken
  if (binding && isWireId(reconnectToken)) return { ...binding, reconnectToken }
}

export function parsePortalRequest(value: unknown): PortalRequest | undefined {
  const payload = fields(value, 'requestId', 'mapEpoch', 'objectId')
  if (!payload) return undefined
  const { requestId, mapEpoch, objectId } = payload
  if (isNonNegativeSafeInteger(requestId) && isNonNegativeSafeInteger(mapEpoch) && isWireId(objectId)) {
    return { requestId, mapEpoch, objectId }
  }
}

export function parseTransferOffer(value: unknown): TransferOffer | undefined {
  const payload = fields(value, 'requestId', 'roomId', 'mapId', 'mapEpoch', 'ticket')
  if (!payload) return undefined
  const { requestId, roomId, mapId, mapEpoch, ticket } = payload
  if (
    (requestId === null || isNonNegativeSafeInteger(requestId)) &&
    isWireId(roomId) &&
    (mapId === 'm1' || mapId === 'village') &&
    isNonNegativeSafeInteger(mapEpoch) &&
    isWireId(ticket)
  )
    return { requestId, roomId, mapId, mapEpoch, ticket }
}

export function parseTransferFailure(value: unknown): TransferFailure | undefined {
  const payload = fields(value, 'requestId', 'code')
  if (!payload) return undefined
  const { requestId, code } = payload
  const failureCode = failureCodes.find((candidate) => candidate === code)
  if ((requestId === null || isNonNegativeSafeInteger(requestId)) && failureCode) return { requestId, code: failureCode }
}

export function parseTransferCancellation(value: unknown): string | undefined {
  const ticket = fields(value, 'ticket')?.ticket
  if (isWireId(ticket)) return ticket
}
