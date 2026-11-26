import type { MapId, WorldPoint } from '@viesma/domain'
import { initialBalanceVersion } from './initial-physics.js'
import type { SpawnId } from './types.js'
import { freeze, id, integer, invalid, record } from './validation.js'

export interface PlayerLifecycleBalance {
  readonly balanceVersion: string
  readonly beginnerMaxHp: number
  readonly beginnerMaxMp: number
  readonly hurtImmunityTicks: number
  readonly respawnDelayTicks: number
  readonly respawnProtectionTicks: number
}

export function loadPlayerLifecycleBalance(input: unknown): PlayerLifecycleBalance {
  const data = record(input, 'playerLifecycle', [
    'balanceVersion',
    'beginnerMaxHp',
    'beginnerMaxMp',
    'hurtImmunityTicks',
    'respawnDelayTicks',
    'respawnProtectionTicks',
  ])
  return Object.freeze({
    balanceVersion: id(data.balanceVersion, 'playerLifecycle.balanceVersion'),
    beginnerMaxHp: integer(data.beginnerMaxHp, 'playerLifecycle.beginnerMaxHp', 1),
    beginnerMaxMp: integer(data.beginnerMaxMp, 'playerLifecycle.beginnerMaxMp', 1),
    hurtImmunityTicks: integer(data.hurtImmunityTicks, 'playerLifecycle.hurtImmunityTicks', 1),
    respawnDelayTicks: integer(data.respawnDelayTicks, 'playerLifecycle.respawnDelayTicks', 1),
    respawnProtectionTicks: integer(data.respawnProtectionTicks, 'playerLifecycle.respawnProtectionTicks', 1),
  })
}

export const initialPlayerLifecycleBalance = loadPlayerLifecycleBalance({
  balanceVersion: initialBalanceVersion,
  beginnerMaxHp: 5000,
  beginnerMaxMp: 30,
  hurtImmunityTicks: 30,
  respawnDelayTicks: 90,
  respawnProtectionTicks: 90,
})

export interface SafeHubFixture {
  readonly mapId: MapId
  readonly spawnId: SpawnId
  readonly position: WorldPoint
  readonly safeZone: { readonly origin: WorldPoint; readonly width: number; readonly height: number }
}

function point(input: unknown, path: string): WorldPoint {
  const value = record(input, path, ['x', 'y'])
  if (typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y)) {
    invalid('INVALID_VALUE', path, 'Expected finite world coordinates')
  }
  return { x: value.x, y: value.y }
}

export function loadSafeHubFixture(input: unknown): SafeHubFixture {
  const data = record(input, 'safeHub', ['mapId', 'spawnId', 'position', 'safeZone'])
  const safeZone = record(data.safeZone, 'safeHub.safeZone', ['origin', 'width', 'height'])
  return freeze({
    mapId: id<MapId>(data.mapId, 'safeHub.mapId'),
    spawnId: id<SpawnId>(data.spawnId, 'safeHub.spawnId'),
    position: point(data.position, 'safeHub.position'),
    safeZone: {
      origin: point(safeZone.origin, 'safeHub.safeZone.origin'),
      width: integer(safeZone.width, 'safeHub.safeZone.width', 1),
      height: integer(safeZone.height, 'safeHub.safeZone.height', 1),
    },
  })
}

export const playgroundSafeHub = loadSafeHubFixture({
  mapId: 'playground',
  spawnId: 'spawn_respawn',
  position: { x: 148, y: 466 },
  safeZone: { origin: { x: 96, y: 410 }, width: 112, height: 104 },
})
