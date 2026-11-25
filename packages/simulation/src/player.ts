import {
  toSimulationTick,
  type AttackId,
  type CharacterId,
  type DerivedCombatStats,
  type MoveX,
  type NonNegativeSafeInteger,
  type Player,
  type SimulationTick,
  type WorldPoint,
} from '@viesma/domain'
import { initialPhysicsBalance, initialPlayerLifecycleBalance } from '@viesma/game-data'
import type { PhysicsVelocity } from '@viesma/physics'

export type FacingDirection = 'left' | 'right'
export type PlayerLocomotion = 'idle' | 'run' | 'jump' | 'fall'
export interface PlayerSwing {
  readonly attackId: AttackId
  readonly acceptedTick: SimulationTick
  readonly inputSeq: NonNegativeSafeInteger
}

export type PlayerAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'attack'; readonly facing: FacingDirection; readonly swing?: PlayerSwing }
  | { readonly kind: 'hurt'; readonly ticksRemaining: number }
  | { readonly kind: 'death'; readonly diedAtTick: SimulationTick }
export type PlayerPresentationState = PlayerLocomotion | Exclude<PlayerAction['kind'], 'none'>

export interface PlayerActionEvent {
  readonly kind: 'attackStarted' | 'attackEnded'
  readonly characterId: CharacterId
  readonly lifeStartedTick: SimulationTick
}

export interface PlayerPhysicsState {
  readonly velocity: PhysicsVelocity
  readonly grounded: boolean
  readonly inVoid: boolean
}

export interface PlayerMovementIntent {
  readonly moveX: MoveX
  readonly lastProcessedInputSeq: NonNegativeSafeInteger | null
  readonly lastInputTick: SimulationTick | null
  readonly jumpBufferTicksRemaining: number
  readonly coyoteTicksRemaining: number
}

export interface SimulationPlayer extends Player {
  readonly vitals: PlayerVitals
  readonly lifeStartedTick: SimulationTick
  readonly lastHurtTick: SimulationTick | null
  readonly lastAttackStartedTick: SimulationTick | null
  readonly spawnProtected: boolean
  readonly spawnProtectionStartedTick: SimulationTick
  readonly physics: PlayerPhysicsState
  readonly movement: PlayerMovementIntent
  readonly facing: FacingDirection
  readonly locomotion: PlayerLocomotion
  readonly action: PlayerAction
}

export type PlayerControllerState = Pick<
  SimulationPlayer,
  'position' | 'physics' | 'movement' | 'facing' | 'locomotion' | 'action' | 'lastHurtTick'
>

export interface PlayerVitals {
  readonly hp: number
  readonly maxHp: number
  readonly mp: number
  readonly maxMp: number
}

export const neutralMovement: PlayerMovementIntent = Object.freeze({
  moveX: 0,
  lastProcessedInputSeq: null,
  lastInputTick: null,
  jumpBufferTicksRemaining: 0,
  coyoteTicksRemaining: 0,
})

export function createPlayer(
  characterId: CharacterId,
  position: WorldPoint,
  grounded: boolean,
  facing: FacingDirection = 'right',
  maxima: Pick<DerivedCombatStats, 'maxHp' | 'maxMp'> = {
    maxHp: initialPlayerLifecycleBalance.beginnerMaxHp,
    maxMp: initialPlayerLifecycleBalance.beginnerMaxMp,
  }
): SimulationPlayer {
  const { maxHp, maxMp } = maxima
  return {
    characterId,
    position: { ...position },
    vitals: { hp: maxHp, maxHp, mp: maxMp, maxMp },
    lifeStartedTick: toSimulationTick(0),
    lastHurtTick: null,
    lastAttackStartedTick: null,
    spawnProtected: false,
    spawnProtectionStartedTick: toSimulationTick(0),
    physics: { velocity: { x: 0, y: 0 }, grounded, inVoid: false },
    movement: neutralMovement,
    facing,
    locomotion: grounded ? 'idle' : 'fall',
    action: { kind: 'none' },
  }
}

export function clampPlayerVitals(
  player: SimulationPlayer,
  { maxHp, maxMp }: Pick<DerivedCombatStats, 'maxHp' | 'maxMp'>
): SimulationPlayer {
  const { hp, mp } = player.vitals
  return { ...player, vitals: { hp: Math.min(hp, maxHp), mp: Math.min(mp, maxMp), maxHp, maxMp } }
}

export function playerFeet({ position }: SimulationPlayer): WorldPoint {
  return {
    x: position.x + initialPhysicsBalance.bodyWidthWorldUnits / 2,
    y: position.y + initialPhysicsBalance.bodyHeightWorldUnits,
  }
}

export function playerCenter(player: SimulationPlayer): WorldPoint {
  const { x, y } = playerFeet(player)
  return { x, y: y - initialPhysicsBalance.bodyHeightWorldUnits / 2 }
}

export function placePlayerAtSpawn(player: SimulationPlayer, position: WorldPoint, facing: FacingDirection): SimulationPlayer {
  return {
    ...player,
    position,
    physics: { velocity: { x: 0, y: 0 }, grounded: true, inVoid: false },
    movement: neutralMovement,
    facing,
    locomotion: 'idle',
    action: { kind: 'none' },
  }
}

export function getPlayerPresentationState(player: Pick<PlayerControllerState, 'action' | 'locomotion'>): PlayerPresentationState {
  return player.action.kind === 'none' ? player.locomotion : player.action.kind
}
