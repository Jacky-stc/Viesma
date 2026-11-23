import { id, integer, record } from './validation.js'

export const initialBalanceVersion = 'mvp-1'

export interface PlayerMovementBalance {
  readonly balanceVersion: string
  readonly bodyWidthWorldUnits: number
  readonly bodyHeightWorldUnits: number
  readonly runSpeedUnitsPerSecond: number
  readonly accelerationUnitsPerSecondSquared: number
  readonly groundDecelerationUnitsPerSecondSquared: number
  readonly gravityUnitsPerSecondSquared: number
  readonly jumpSpeedUnitsPerSecond: number
  readonly terminalFallSpeedUnitsPerSecond: number
  readonly voidDepthWorldUnits: number
  readonly jumpBufferTicks: number
  readonly coyoteTimeTicks: number
  readonly hurtTicks: number
}

/** GAME_DESIGN §2 的角色控制與物理初始平衡。 */
export const initialPhysicsBalance: PlayerMovementBalance = Object.freeze({
  balanceVersion: initialBalanceVersion,
  bodyWidthWorldUnits: 24,
  bodyHeightWorldUnits: 48,
  runSpeedUnitsPerSecond: 220,
  accelerationUnitsPerSecondSquared: 1800,
  groundDecelerationUnitsPerSecondSquared: 2200,
  gravityUnitsPerSecondSquared: 1800,
  jumpSpeedUnitsPerSecond: 600,
  terminalFallSpeedUnitsPerSecond: 900,
  voidDepthWorldUnits: 64,
  jumpBufferTicks: 3,
  coyoteTimeTicks: 3,
  hurtTicks: 6,
})

export function loadPlayerMovementBalance(input: unknown): PlayerMovementBalance {
  const data = record(input, 'movement', Object.keys(initialPhysicsBalance))
  return Object.freeze({
    balanceVersion: id(data.balanceVersion, 'movement.balanceVersion'),
    bodyWidthWorldUnits: integer(data.bodyWidthWorldUnits, 'movement.bodyWidthWorldUnits', 1),
    bodyHeightWorldUnits: integer(data.bodyHeightWorldUnits, 'movement.bodyHeightWorldUnits', 1),
    runSpeedUnitsPerSecond: integer(data.runSpeedUnitsPerSecond, 'movement.runSpeedUnitsPerSecond', 1),
    accelerationUnitsPerSecondSquared: integer(data.accelerationUnitsPerSecondSquared, 'movement.accelerationUnitsPerSecondSquared', 1),
    groundDecelerationUnitsPerSecondSquared: integer(
      data.groundDecelerationUnitsPerSecondSquared,
      'movement.groundDecelerationUnitsPerSecondSquared',
      1
    ),
    gravityUnitsPerSecondSquared: integer(data.gravityUnitsPerSecondSquared, 'movement.gravityUnitsPerSecondSquared'),
    jumpSpeedUnitsPerSecond: integer(data.jumpSpeedUnitsPerSecond, 'movement.jumpSpeedUnitsPerSecond', 1),
    terminalFallSpeedUnitsPerSecond: integer(data.terminalFallSpeedUnitsPerSecond, 'movement.terminalFallSpeedUnitsPerSecond', 1),
    voidDepthWorldUnits: integer(data.voidDepthWorldUnits, 'movement.voidDepthWorldUnits'),
    jumpBufferTicks: integer(data.jumpBufferTicks, 'movement.jumpBufferTicks'),
    coyoteTimeTicks: integer(data.coyoteTimeTicks, 'movement.coyoteTimeTicks'),
    hurtTicks: integer(data.hurtTicks, 'movement.hurtTicks', 1),
  })
}
