import type { MapId, WorldPoint } from '@viesma/domain'
import type { Aabb } from '@viesma/physics'
import { initialPhysicsBalance } from '../initial-physics.js'
import type { MonsterArchetypeId, MonsterDefinition, PortalId, SpawnId } from '../types.js'
import { choice, id, integer, invalid, reference } from '../validation.js'
import { boolean, coordinate, defaultOnly, properties, property, propertyFields, tiledRecord, unsupported } from './format.js'
import type { MapCollider, MapMonsterSpawn, MapPlayerSpawn, MapPoint, MapPortal } from './types.js'

type MapObject =
  | { readonly kind: 'collider'; readonly value: MapCollider }
  | { readonly kind: 'spawn'; readonly value: MapPlayerSpawn }
  | { readonly kind: 'portal'; readonly value: MapPortal }
  | { readonly kind: 'monster'; readonly value: MapMonsterSpawn }
  | { readonly kind: 'npc' | 'loot'; readonly value: MapPoint }

export type LocatedMapObject = MapObject & { readonly path: string }

const objectClasses = ['SolidRect', 'OneWayPlatform', 'PlayerSpawn', 'Portal', 'MonsterSpawn', 'Npc', 'LootFallback'] as const
const portalKeys = ['portalId', 'destinationMapId', 'destinationSpawnId', 'reversePortalId'] as const
const monsterKeys = ['spawnId', 'monsterArchetypeId', 'level'] as const
const patrolKeys = ['floorId', 'patrolMinX', 'patrolMaxX'] as const

export function contains(outer: Aabb, inner: Aabb): boolean {
  return (
    inner.origin.x >= outer.origin.x &&
    inner.origin.y >= outer.origin.y &&
    inner.origin.x + inner.width <= outer.origin.x + outer.width &&
    inner.origin.y + inner.height <= outer.origin.y + outer.height
  )
}

function pointInMap(point: WorldPoint, bounds: Aabb, path: string): void {
  if (point.x < 0 || point.x >= bounds.width) invalid('OUT_OF_RANGE', `${path}.x`, 'Point must be within map width')
  if (point.y < 0 || point.y >= bounds.height) invalid('OUT_OF_RANGE', `${path}.y`, 'Point must be within map height')
}

export function playerBody(position: WorldPoint): Aabb {
  return { origin: position, width: initialPhysicsBalance.bodyWidthWorldUnits, height: initialPhysicsBalance.bodyHeightWorldUnits }
}

function validateShape(value: Record<string, unknown>, isPoint: boolean, bounds: Aabb, path: string): Aabb {
  if ((value.point ?? false) !== isPoint) unsupported(`${path}.point`, isPoint ? 'Expected a Point object' : 'Expected a Rectangle object')
  const origin = { x: coordinate(value.x, `${path}.x`), y: coordinate(value.y, `${path}.y`) }
  pointInMap(origin, bounds, path)
  const width = coordinate(value.width, `${path}.width`)
  const height = coordinate(value.height, `${path}.height`)
  if (isPoint ? width !== 0 : width <= 0) {
    invalid('OUT_OF_RANGE', `${path}.width`, isPoint ? 'Point width must be zero' : 'Rectangle width must be positive')
  }
  if (isPoint ? height !== 0 : height <= 0) {
    invalid('OUT_OF_RANGE', `${path}.height`, isPoint ? 'Point height must be zero' : 'Rectangle height must be positive')
  }
  if (origin.x + width > bounds.width) invalid('OUT_OF_RANGE', `${path}.width`, 'Right edge exceeds map bounds')
  if (origin.y + height > bounds.height) invalid('OUT_OF_RANGE', `${path}.height`, 'Bottom edge exceeds map bounds')
  return { origin, width, height }
}

export function parseMapObject(
  input: unknown,
  path: string,
  bounds: Aabb,
  objectIds: Set<number>,
  monsters: ReadonlyMap<MonsterArchetypeId, MonsterDefinition>,
  levelCap: number
): LocatedMapObject {
  const value = tiledRecord(
    input,
    path,
    ['id', 'name', 'type', 'x', 'y', 'width', 'height', 'rotation'],
    ['visible', 'opacity', 'properties', 'point', 'ellipse', 'capsule', 'polygon', 'polyline', 'gid', 'text', 'template']
  )
  for (const shape of ['ellipse', 'capsule', 'polygon', 'polyline', 'gid', 'text', 'template']) {
    if (Object.hasOwn(value, shape)) unsupported(`${path}.${shape}`, 'Only plain rectangles and points are supported')
  }
  defaultOnly(value.rotation, `${path}.rotation`, 0)
  defaultOnly(value.opacity, `${path}.opacity`, 1)
  if (value.visible !== undefined) boolean(value.visible, `${path}.visible`)
  if (value.point !== undefined) boolean(value.point, `${path}.point`)
  const objectId = integer(value.id, `${path}.id`, 1)
  if (objectIds.has(objectId)) invalid('DUPLICATE_ID', `${path}.id`, `Duplicate Tiled object ID ${objectId}`)
  objectIds.add(objectId)
  if (typeof value.name !== 'string') invalid('INVALID_TYPE', `${path}.name`, 'Expected a Tiled object name')
  const objectClass = choice(value.type, `${path}.type`, objectClasses)
  const propsPath = `${path}.properties`
  const props = properties(value.properties, propsPath)

  if (objectClass === 'MonsterSpawn') {
    const monsterArchetypeId = property(props, propsPath, 'monsterArchetypeId', ['string'], id<MonsterArchetypeId>)
    const { movement } = reference(monsters, monsterArchetypeId, `${propsPath}[monsterArchetypeId]`)
    propertyFields(props, propsPath, movement === 'ground' ? [...monsterKeys, ...patrolKeys] : monsterKeys)
    const region = validateShape(value, movement === 'ground', bounds, path)
    const fields = {
      id: property(props, propsPath, 'spawnId', ['string'], id<SpawnId>),
      monsterArchetypeId,
      level: property(props, propsPath, 'level', ['int'], (input, path) => integer(input, path, 1, levelCap)),
    }
    if (movement === 'flight') {
      const position = {
        x: coordinate(region.origin.x + region.width / 2, `${path}.width`),
        y: coordinate(region.origin.y + region.height / 2, `${path}.height`),
      }
      return { path, kind: 'monster', value: { ...fields, movement, position, flightBounds: region } }
    }
    return {
      path,
      kind: 'monster',
      value: {
        ...fields,
        movement,
        position: region.origin,
        floorId: property(props, propsPath, 'floorId', ['string'], id),
        patrolMinX: property(props, propsPath, 'patrolMinX', ['float', 'int'], coordinate),
        patrolMaxX: property(props, propsPath, 'patrolMaxX', ['float', 'int'], coordinate),
      },
    }
  }

  const isPoint = objectClass === 'PlayerSpawn' || objectClass === 'Npc' || objectClass === 'LootFallback'
  const region = validateShape(value, isPoint, bounds, path)
  if (objectClass === 'PlayerSpawn') {
    propertyFields(props, propsPath, ['spawnId', 'facing'])
    const position = {
      x: region.origin.x - initialPhysicsBalance.bodyWidthWorldUnits / 2,
      y: region.origin.y - initialPhysicsBalance.bodyHeightWorldUnits,
    }
    if (!contains(bounds, playerBody(position))) {
      invalid('OUT_OF_RANGE', `${path}.x/y`, 'Spawn requires room for the entire player body above and around the feet')
    }
    const facing = property(props, propsPath, 'facing', ['string'], (input, path) => choice(input, path, ['left', 'right']))
    return { path, kind: 'spawn', value: { id: property(props, propsPath, 'spawnId', ['string'], id<SpawnId>), position, facing } }
  }
  if (objectClass === 'Portal') {
    propertyFields(props, propsPath, portalKeys)
    return {
      path,
      kind: 'portal',
      value: {
        id: property(props, propsPath, 'portalId', ['string'], id<PortalId>),
        destinationMapId: property(props, propsPath, 'destinationMapId', ['string'], id<MapId>),
        destinationSpawnId: property(props, propsPath, 'destinationSpawnId', ['string'], id<SpawnId>),
        reversePortalId: property(props, propsPath, 'reversePortalId', ['string'], id<PortalId>),
        bounds: region,
      },
    }
  }
  propertyFields(props, propsPath, [])
  const objectKey = id(value.name, `${path}.name`)
  if (objectClass === 'Npc' || objectClass === 'LootFallback') {
    return { path, kind: objectClass === 'Npc' ? 'npc' : 'loot', value: { id: objectKey, position: region.origin } }
  }
  return { path, kind: 'collider', value: { id: objectKey, kind: objectClass === 'SolidRect' ? 'solid' : 'oneWay', bounds: region } }
}
