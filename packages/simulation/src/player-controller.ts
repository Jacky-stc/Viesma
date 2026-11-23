import { fixedDeltaSeconds, type SimulationTick } from '@viesma/domain'
import { GameDataValidationError, initialPhysicsBalance, loadPlayerMovementBalance, type PlayerMovementBalance } from '@viesma/game-data'
import { createPhysicsStepper, maxPhysicsSpeed, type PhysicsWorldDefinition } from '@viesma/physics'
import type { PlayerInputCommand } from './movement-input.js'
import type { FacingDirection, PlayerAction, PlayerActionEvent, PlayerControllerState, PlayerPhysicsState } from './player.js'

const inputTimeoutTicks = 6

type ActionEventKinds = ReadonlySet<PlayerActionEvent['kind']>

export type PlayerController = <State extends PlayerControllerState>(
  player: State,
  input: Pick<PlayerInputCommand, 'seq' | 'moveX' | 'jumpPressed'> | undefined,
  events: ActionEventKinds | undefined,
  tick: SimulationTick
) => PlayerControllerState & Omit<State, keyof PlayerControllerState>

function resolveAction(
  action: PlayerAction,
  events: ActionEventKinds | undefined,
  facing: FacingDirection,
  tookDamage: boolean,
  hurtTicks: number
): PlayerAction {
  if (tookDamage) return { kind: 'hurt', ticksRemaining: hurtTicks }
  if (action.kind === 'hurt' && action.ticksRemaining > 1) return { kind: 'hurt', ticksRemaining: action.ticksRemaining - 1 }
  if (action.kind === 'attack' && !events?.has('attackEnded')) return action
  return events?.has('attackStarted') ? { kind: 'attack', facing } : { kind: 'none' }
}

function classifyLocomotion({ grounded, velocity }: PlayerPhysicsState): PlayerControllerState['locomotion'] {
  if (grounded) return velocity.x === 0 ? 'idle' : 'run'
  return velocity.y < 0 ? 'jump' : 'fall'
}

function approachSpeed(current: number, target: number, maxChange: number): number {
  const difference = target - current
  // 消除累積的小數捨入誤差，煞停時落在精確的零速。
  const roundingError = Number.EPSILON * (Math.abs(current) + Math.abs(target) + maxChange)
  return Math.abs(difference) <= maxChange + roundingError ? target : current + Math.sign(difference) * maxChange
}

export function createPlayerController(
  world: Omit<PhysicsWorldDefinition, 'voidDepthWorldUnits'>,
  balance: PlayerMovementBalance = initialPhysicsBalance
): PlayerController {
  const config = loadPlayerMovementBalance(balance)
  if (config.runSpeedUnitsPerSecond > maxPhysicsSpeed) {
    throw new GameDataValidationError('OUT_OF_RANGE', 'movement.runSpeedUnitsPerSecond', 'Run speed exceeds the physics limit')
  }
  const stepPhysics = createPhysicsStepper({ ...world, voidDepthWorldUnits: config.voidDepthWorldUnits }, config)
  const accelerationPerTick = config.accelerationUnitsPerSecondSquared * fixedDeltaSeconds
  const groundDecelerationPerTick = config.groundDecelerationUnitsPerSecondSquared * fixedDeltaSeconds

  return (player, input, events, tick) => {
    if (player.action.kind === 'death' || player.physics.inVoid) return player

    const { movement, physics } = player
    const lastSeq = movement.lastProcessedInputSeq
    const frame = input && (lastSeq === null || input.seq > lastSeq) ? input : undefined
    const lastInputTick = frame ? tick : movement.lastInputTick
    const moveX = frame?.moveX ?? (lastInputTick !== null && tick - lastInputTick < inputTimeoutTicks ? movement.moveX : 0)
    const facing = moveX === 0 ? player.facing : moveX === -1 ? 'left' : 'right'
    const action = resolveAction(player.action, events, facing, player.lastHurtTick === tick, config.hurtTicks)

    const canUseJumpEdge = action.kind !== 'hurt'
    const newJumpEdge = canUseJumpEdge && frame?.jumpPressed === true
    const jumpRequested = canUseJumpEdge && (newJumpEdge || movement.jumpBufferTicksRemaining > 0)
    const allowCoyoteJump = !physics.grounded && movement.coyoteTicksRemaining > 0
    const jumpPressed = jumpRequested && (physics.grounded || allowCoyoteJump) && physics.velocity.y >= 0

    const speedX = physics.velocity.x
    const horizontalSpeedUnitsPerSecond =
      moveX === 0 && !physics.grounded
        ? speedX
        : approachSpeed(speedX, moveX * config.runSpeedUnitsPerSecond, moveX === 0 ? groundDecelerationPerTick : accelerationPerTick)
    const result = stepPhysics(
      {
        bounds: { origin: player.position, width: config.bodyWidthWorldUnits, height: config.bodyHeightWorldUnits },
        velocity: physics.velocity,
      },
      { horizontalSpeedUnitsPerSecond, jumpPressed, allowCoyoteJump: jumpPressed && allowCoyoteJump },
      fixedDeltaSeconds
    )

    let jumpBufferTicksRemaining = 0
    if (canUseJumpEdge && !jumpPressed) {
      jumpBufferTicksRemaining = newJumpEdge ? config.jumpBufferTicks : Math.max(0, movement.jumpBufferTicksRemaining - 1)
    }
    let coyoteTicksRemaining = 0
    if (!jumpPressed && !result.grounded) {
      coyoteTicksRemaining = physics.grounded ? config.coyoteTimeTicks : Math.max(0, movement.coyoteTicksRemaining - 1)
    }

    const nextPhysics = { velocity: result.body.velocity, grounded: result.grounded, inVoid: result.inVoid }
    return {
      ...player,
      position: result.body.bounds.origin,
      physics: nextPhysics,
      movement: { moveX, lastProcessedInputSeq: frame?.seq ?? lastSeq, lastInputTick, jumpBufferTicksRemaining, coyoteTicksRemaining },
      facing,
      locomotion: classifyLocomotion(nextPhysics),
      action,
    }
  }
}
