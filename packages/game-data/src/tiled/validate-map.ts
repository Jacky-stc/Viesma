import { fixedDeltaSeconds, type WorldPoint } from '@viesma/domain'
import { createPhysicsStepper, PhysicsValidationError, type Aabb } from '@viesma/physics'
import { initialPhysicsBalance } from '../initial-physics.js'
import type { MapDefinition } from '../types.js'
import { invalid, reference } from '../validation.js'
import { createLootPlacement } from './loot-placement.js'
import { playerBody } from './objects.js'
import type { MapCollider, MapMonsterSpawn, NormalizedMap } from './types.js'

type ObjectPath = (kind: 'portal' | 'spawn' | 'monster' | 'loot' | 'npc', id: string) => string

function overlapsX(a: Aabb, b: Aabb): boolean {
  return a.origin.x < b.origin.x + b.width && a.origin.x + a.width > b.origin.x
}

function overlapsArea(a: Aabb, b: Aabb): boolean {
  return overlapsX(a, b) && a.origin.y < b.origin.y + b.height && a.origin.y + a.height > b.origin.y
}

function intersectsCollider(area: Aabb, { kind, bounds }: MapCollider): boolean {
  return kind === 'solid'
    ? overlapsArea(area, bounds)
    : overlapsX(area, bounds) && area.origin.y < bounds.origin.y && bounds.origin.y < area.origin.y + area.height
}

function clearPoint(point: WorldPoint, colliders: readonly MapCollider[], path: string): void {
  const blocked = colliders.some(({ kind, bounds: { origin, width, height } }) => {
    return kind === 'solid' && origin.x < point.x && point.x < origin.x + width && origin.y < point.y && point.y < origin.y + height
  })
  if (blocked) invalid('INVALID_VALUE', path, 'Point is inside a solid collider')
}

function validateMonster(spawn: MapMonsterSpawn, colliders: ReadonlyMap<string, MapCollider>, path: string): void {
  if (spawn.movement === 'ground') {
    const floor = reference(colliders, spawn.floorId, `${path}.properties[floorId]`).bounds
    const { patrolMinX, patrolMaxX, position } = spawn
    if (
      position.y !== floor.origin.y ||
      patrolMinX < floor.origin.x ||
      patrolMinX >= patrolMaxX ||
      patrolMaxX > floor.origin.x + floor.width ||
      position.x < patrolMinX ||
      position.x > patrolMaxX
    ) {
      invalid('INVALID_VALUE', `${path}.properties[patrolMinX/patrolMaxX]`, 'Patrol and spawn must lie on the referenced floor top')
    }
    for (const { kind, bounds } of colliders.values()) {
      if (
        kind === 'solid' &&
        bounds.origin.x < patrolMaxX &&
        bounds.origin.x + bounds.width > patrolMinX &&
        bounds.origin.y < position.y &&
        bounds.origin.y + bounds.height >= position.y
      ) {
        invalid('INVALID_VALUE', `${path}.properties[patrolMinX/patrolMaxX]`, 'Patrol segment is obstructed by a solid collider')
      }
    }
    return
  }
  for (const { kind, bounds } of colliders.values()) {
    if (kind === 'solid' && overlapsArea(spawn.flightBounds, bounds)) {
      invalid('INVALID_VALUE', path, 'Flight region overlaps solid geometry')
    }
  }
}

export function validateMap(map: NormalizedMap, manifest: MapDefinition, path: string, objectPath: ObjectPath): void {
  const colliders = new Map(map.colliders.map((collider) => [collider.id, collider]))
  const step = createPhysicsStepper(map, initialPhysicsBalance)
  const expectedSpawns = new Set(manifest.spawnIds)
  const expectedPortals = new Map(manifest.portals.map((portal) => [portal.id, portal]))
  for (const portal of map.portals) {
    const portalPath = objectPath('portal', portal.id)
    const expected = reference(expectedPortals, portal.id, `${portalPath}.properties[portalId]`)
    expectedPortals.delete(portal.id)
    for (const field of ['destinationMapId', 'destinationSpawnId', 'reversePortalId'] as const) {
      if (portal[field] !== expected[field]) {
        invalid('INVALID_REFERENCE', `${portalPath}.properties[${field}]`, `Manifest requires "${expected[field]}"`)
      }
    }
    if (map.colliders.some((collider) => intersectsCollider(portal.bounds, collider))) {
      invalid('INVALID_VALUE', portalPath, 'Portal trigger intersects solid geometry or a one-way surface')
    }
  }
  for (const spawn of map.spawns) {
    const spawnPath = objectPath('spawn', spawn.id)
    if (!expectedSpawns.delete(spawn.id)) invalid('UNKNOWN_REFERENCE', `${spawnPath}.properties[spawnId]`, 'Spawn is absent from manifest')
    const bounds = playerBody(spawn.position)
    if (map.portals.some((portal) => overlapsArea(bounds, portal.bounds))) {
      invalid('INVALID_VALUE', spawnPath, 'Spawn body overlaps a portal trigger')
    }
    if (map.colliders.some((collider) => collider.kind === 'oneWay' && intersectsCollider(bounds, collider))) {
      invalid('INVALID_VALUE', spawnPath, 'Spawn body intersects a one-way surface')
    }
    try {
      const result = step({ bounds, velocity: { x: 0, y: 0 } }, { horizontalSpeedUnitsPerSecond: 0, jumpPressed: false }, fixedDeltaSeconds)
      if (!result.grounded || result.inVoid || result.body.bounds.origin.y !== bounds.origin.y) {
        invalid('INVALID_VALUE', spawnPath, 'Spawn feet must already rest on a solid or one-way surface')
      }
    } catch (error) {
      if (!(error instanceof PhysicsValidationError)) throw error
      invalid('INVALID_VALUE', spawnPath, error.message)
    }
  }
  for (const [kind, missing] of [
    ['PlayerSpawn', [...expectedSpawns]],
    ['Portal', [...expectedPortals.keys()]],
  ] as const) {
    if (missing.length > 0) invalid('MISSING_FIELD', path, `Missing ${kind} objects: ${missing.join(', ')}`)
  }

  const remainingMonsters = new Map(manifest.monsterGroups.map((group) => [`${group.monsterArchetypeId}:${group.level}`, group.count]))
  let hasFlyingSpawn = false
  for (const spawn of map.monsterSpawns) {
    const spawnPath = objectPath('monster', spawn.id)
    const group = `${spawn.monsterArchetypeId}:${spawn.level}`
    const remaining = reference(remainingMonsters, group, `${spawnPath}.properties[monsterArchetypeId/level]`)
    if (remaining === 0) invalid('OUT_OF_RANGE', spawnPath, `Too many MonsterSpawn objects for ${group}`)
    remainingMonsters.set(group, remaining - 1)
    validateMonster(spawn, colliders, spawnPath)
    if (spawn.movement === 'flight') hasFlyingSpawn = true
  }
  for (const point of map.npcs) clearPoint(point.position, map.colliders, objectPath('npc', point.id))
  const placement = createLootPlacement(map)
  for (const point of map.lootFallbacks) {
    const pointPath = objectPath('loot', point.id)
    if (!placement.safe(point.position)) invalid('INVALID_VALUE', pointPath, 'Loot fallback requires a clear supporting surface')
  }
  if (hasFlyingSpawn && map.lootFallbacks.length === 0) {
    invalid('MISSING_FIELD', path, 'A map with a flying MonsterSpawn requires a LootFallback')
  }
  if (map.monsterSpawns.length > 0 && !placement.fallback)
    invalid('MISSING_FIELD', path, 'A map with monsters requires a safe loot fallback or player spawn')
}
