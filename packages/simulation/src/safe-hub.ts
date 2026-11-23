import type { MapId } from '@viesma/domain'
import {
  GameDataValidationError,
  initialPhysicsBalance,
  loadPlayerMovementBalance,
  loadSafeHubFixture,
  type PlayerMovementBalance,
  type SafeHubFixture,
} from '@viesma/game-data'
import { createPhysicsStepper, type Aabb, type PhysicsWorldDefinition } from '@viesma/physics'
import { fixedDeltaSeconds } from './fixed-tick.js'

const verifiedSpawn = Symbol('verifiedSpawn')

export interface SafeHubSpawn extends SafeHubFixture {
  readonly [verifiedSpawn]: true
}

export function resolveSafeHubSpawn(spawn: SafeHubSpawn | undefined, mapId: MapId): SafeHubSpawn | undefined {
  return spawn?.[verifiedSpawn] === true && spawn.mapId === mapId ? spawn : undefined
}

function contains(container: Aabb, body: Aabb): boolean {
  return (
    body.origin.x >= container.origin.x &&
    body.origin.y >= container.origin.y &&
    body.origin.x + body.width <= container.origin.x + container.width &&
    body.origin.y + body.height <= container.origin.y + container.height
  )
}

export function createSafeHubSpawn(
  world: Omit<PhysicsWorldDefinition, 'voidDepthWorldUnits'>,
  input: unknown,
  balance: PlayerMovementBalance = initialPhysicsBalance
): SafeHubSpawn {
  const fixture = loadSafeHubFixture(input)
  const config = loadPlayerMovementBalance(balance)
  const stepPhysics = createPhysicsStepper({ ...world, voidDepthWorldUnits: config.voidDepthWorldUnits }, config)
  const bounds = { origin: fixture.position, width: config.bodyWidthWorldUnits, height: config.bodyHeightWorldUnits }
  if (!contains(world.bounds, fixture.safeZone) || !contains(fixture.safeZone, bounds)) {
    throw new GameDataValidationError(
      'OUT_OF_RANGE',
      'safeHub.position',
      'The zone and entire spawn body must fit within the map and safe zone'
    )
  }
  const result = stepPhysics(
    { bounds, velocity: { x: 0, y: 0 } },
    { horizontalSpeedUnitsPerSecond: 0, jumpPressed: false },
    fixedDeltaSeconds
  )
  if (!result.grounded || result.inVoid || result.body.bounds.origin.y !== fixture.position.y) {
    throw new GameDataValidationError('INVALID_VALUE', 'safeHub.position', 'The spawn must already stand on a supporting surface')
  }
  return Object.freeze({ ...fixture, [verifiedSpawn]: true as const })
}
