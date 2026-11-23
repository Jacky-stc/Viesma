import {
  isNonNegativeSafeInteger,
  toSimulationTick,
  type MoveX,
  type NonNegativeSafeInteger,
  type SimulationTick,
  type WorldPoint,
} from '@viesma/domain'
import { PROTOCOL_VERSION } from './join-version.js'
import { isWireId, parseMapRoomJoin, type MapRoomJoin } from './map-room.js'

type Facing = 'left' | 'right'
type Locomotion = 'idle' | 'run' | 'jump' | 'fall'
type MovementAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'attack'; readonly facing: Facing }
  | { readonly kind: 'hurt'; readonly ticksRemaining: number }
  | { readonly kind: 'death'; readonly diedAtTick: SimulationTick }

export interface MovementCheckpoint extends MapRoomJoin {
  readonly protocolVersion: number
  readonly mapInstanceId: string
  readonly serverTick: SimulationTick
  readonly lifeStartedTick: SimulationTick
  /** 此序號以下的幀均已結案，包含套用、衝突及佇列捨棄。 */
  readonly ackInputSeq: NonNegativeSafeInteger | null
  readonly controller: {
    readonly position: WorldPoint
    readonly physics: { readonly velocity: WorldPoint; readonly grounded: boolean; readonly inVoid: boolean }
    readonly movement: {
      readonly moveX: MoveX
      readonly lastProcessedInputSeq: NonNegativeSafeInteger | null
      readonly lastInputTick: SimulationTick | null
      readonly jumpBufferTicksRemaining: number
      readonly coyoteTicksRemaining: number
    }
    readonly facing: Facing
    readonly locomotion: Locomotion
    readonly action: MovementAction
    readonly lastHurtTick: SimulationTick | null
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined
}

function point(value: unknown): WorldPoint | undefined {
  const { x, y } = record(value) ?? {}
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? { x, y } : undefined
}

function nullableTick(value: unknown, serverTick: SimulationTick): SimulationTick | null | undefined {
  if (value === null) return null
  if (isNonNegativeSafeInteger(value) && value <= serverTick) return toSimulationTick(value)
  return undefined
}

function parseAction(value: unknown, serverTick: SimulationTick): MovementAction | undefined {
  const { kind, facing, ticksRemaining, diedAtTick } = record(value) ?? {}
  if (kind === 'none') return { kind }
  if (kind === 'attack' && (facing === 'left' || facing === 'right')) return { kind, facing }
  if (kind === 'hurt' && isNonNegativeSafeInteger(ticksRemaining) && ticksRemaining > 0) return { kind, ticksRemaining }
  if (kind === 'death' && isNonNegativeSafeInteger(diedAtTick) && diedAtTick <= serverTick) {
    return { kind, diedAtTick: toSimulationTick(diedAtTick) }
  }
  return undefined
}

export function parseMovementCheckpoint(payload: unknown): MovementCheckpoint | undefined {
  const value = record(payload)
  const binding = parseMapRoomJoin(value)
  if (!value || !binding) return undefined
  const { protocolVersion, mapInstanceId, serverTick: rawTick, lifeStartedTick, ackInputSeq } = value
  if (
    protocolVersion !== PROTOCOL_VERSION ||
    !isWireId(mapInstanceId) ||
    !isNonNegativeSafeInteger(rawTick) ||
    !isNonNegativeSafeInteger(lifeStartedTick) ||
    lifeStartedTick > rawTick ||
    (ackInputSeq !== null && !isNonNegativeSafeInteger(ackInputSeq))
  )
    return undefined

  const serverTick = toSimulationTick(rawTick)
  const {
    position: rawPosition,
    physics: rawPhysics,
    movement: rawMovement,
    facing,
    locomotion,
    action: rawAction,
    lastHurtTick: rawHurtTick,
  } = record(value.controller) ?? {}
  const { velocity: rawVelocity, grounded, inVoid } = record(rawPhysics) ?? {}
  const {
    moveX,
    lastProcessedInputSeq,
    lastInputTick: rawInputTick,
    jumpBufferTicksRemaining,
    coyoteTicksRemaining,
  } = record(rawMovement) ?? {}
  const position = point(rawPosition)
  const velocity = point(rawVelocity)
  const action = parseAction(rawAction, serverTick)
  const lastInputTick = nullableTick(rawInputTick, serverTick)
  const lastHurtTick = nullableTick(rawHurtTick, serverTick)
  if (
    !position ||
    !velocity ||
    !action ||
    typeof grounded !== 'boolean' ||
    typeof inVoid !== 'boolean' ||
    (facing !== 'left' && facing !== 'right') ||
    (locomotion !== 'idle' && locomotion !== 'run' && locomotion !== 'jump' && locomotion !== 'fall') ||
    (moveX !== -1 && moveX !== 0 && moveX !== 1) ||
    (lastProcessedInputSeq !== null &&
      (!isNonNegativeSafeInteger(lastProcessedInputSeq) || ackInputSeq === null || lastProcessedInputSeq > ackInputSeq)) ||
    lastInputTick === undefined ||
    lastHurtTick === undefined ||
    !isNonNegativeSafeInteger(jumpBufferTicksRemaining) ||
    !isNonNegativeSafeInteger(coyoteTicksRemaining)
  )
    return undefined

  return {
    ...binding,
    protocolVersion,
    mapInstanceId,
    serverTick,
    lifeStartedTick: toSimulationTick(lifeStartedTick),
    ackInputSeq,
    controller: {
      position,
      physics: { velocity, grounded, inVoid },
      movement: { moveX, lastProcessedInputSeq, lastInputTick, jumpBufferTicksRemaining, coyoteTicksRemaining },
      facing,
      locomotion,
      action,
      lastHurtTick,
    },
  }
}
