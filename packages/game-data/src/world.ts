import type { MapId } from '@viesma/domain'
import type { GameData, MapDefinition, MapMonsterGroup, MonsterArchetypeId, PortalDefinition, SpawnId, WorldDefinition } from './types.js'
import { array, compareIds, id, integer, invalid, maxContentInteger, name, record, reference, uniqueBy } from './validation.js'

function parsePortal(input: unknown, path: string): PortalDefinition {
  const portal = record(input, path, ['id', 'destinationMapId', 'destinationSpawnId', 'reversePortalId'])
  return {
    id: id(portal.id, `${path}.id`),
    destinationMapId: id(portal.destinationMapId, `${path}.destinationMapId`),
    destinationSpawnId: id(portal.destinationSpawnId, `${path}.destinationSpawnId`),
    reversePortalId: id(portal.reversePortalId, `${path}.reversePortalId`),
  }
}

function parseMap(input: unknown, path: string, levelCap: number, maxMonsters: number, maxTiles: number): MapDefinition {
  const map = record(input, path, ['id', 'name', 'widthTiles', 'heightTiles', 'recommendedLevels', 'spawnIds', 'portals', 'monsterGroups'])
  const levels = map.recommendedLevels === null ? null : record(map.recommendedLevels, `${path}.recommendedLevels`, ['min', 'max'])
  const minLevel = levels === null ? 1 : integer(levels.min, `${path}.recommendedLevels.min`, 1, levelCap)
  const monsterGroups = array(
    map.monsterGroups,
    `${path}.monsterGroups`,
    (input, groupPath): MapMonsterGroup => {
      const group = record(input, groupPath, ['monsterArchetypeId', 'level', 'count'])
      return {
        monsterArchetypeId: id(group.monsterArchetypeId, `${groupPath}.monsterArchetypeId`),
        level: integer(group.level, `${groupPath}.level`, 1, levelCap),
        count: integer(group.count, `${groupPath}.count`, 1, maxMonsters),
      }
    },
    0,
    maxMonsters
  )

  if (levels === null && monsterGroups.length > 0) {
    invalid('INVALID_VALUE', `${path}.monsterGroups`, 'A safe map must have no monster groups')
  }
  if (monsterGroups.reduce((count, group) => count + group.count, 0) > maxMonsters) {
    invalid('OUT_OF_RANGE', `${path}.monsterGroups`, `Total spawn count exceeds ${maxMonsters}`)
  }

  return {
    id: id(map.id, `${path}.id`),
    name: name(map.name, `${path}.name`),
    widthTiles: integer(map.widthTiles, `${path}.widthTiles`, 1, maxTiles),
    heightTiles: integer(map.heightTiles, `${path}.heightTiles`, 1, maxTiles),
    recommendedLevels:
      levels === null ? null : { min: minLevel, max: integer(levels.max, `${path}.recommendedLevels.max`, minLevel, levelCap) },
    spawnIds: array(map.spawnIds, `${path}.spawnIds`, id<SpawnId>, 1),
    portals: array(map.portals, `${path}.portals`, parsePortal),
    monsterGroups,
  }
}

export function parseWorld(input: unknown, levelCap: number, monsters: ReadonlyMap<MonsterArchetypeId, unknown>): WorldDefinition {
  const world = record(input, 'world', ['tileSizeWorldUnits', 'maxMonstersPerMap', 'respawn', 'maps'])
  const tileSizeWorldUnits = integer(world.tileSizeWorldUnits, 'world.tileSizeWorldUnits', 1)
  const maxMonstersPerMap = integer(world.maxMonstersPerMap, 'world.maxMonstersPerMap', 1)
  const maxTiles = Math.floor(maxContentInteger / tileSizeWorldUnits)
  const respawn = record(world.respawn, 'world.respawn', ['mapId', 'spawnId'])
  const respawnMapId = id<MapId>(respawn.mapId, 'world.respawn.mapId')
  const respawnSpawnId = id<SpawnId>(respawn.spawnId, 'world.respawn.spawnId')
  const maps = array(world.maps, 'world.maps', (input, path) => parseMap(input, path, levelCap, maxMonstersPerMap, maxTiles), 1)
  const mapIndex = uniqueBy(maps, (map) => map.id, 'world.maps')

  const objectsByMap = new Map(
    maps.map((map, index) => {
      const path = `world.maps[${index}]`
      return [
        map.id,
        {
          spawns: uniqueBy(map.spawnIds, (id) => id, `${path}.spawnIds`, ''),
          portals: uniqueBy(map.portals, (portal) => portal.id, `${path}.portals`),
        },
      ] as const
    })
  )

  const respawnMap = reference(mapIndex, respawnMapId, 'world.respawn.mapId')
  if (respawnMap.recommendedLevels !== null) {
    invalid('INVALID_REFERENCE', 'world.respawn.mapId', 'Respawn requires a safe map')
  }
  if (!respawnMap.spawnIds.includes(respawnSpawnId)) {
    invalid('UNKNOWN_REFERENCE', 'world.respawn.spawnId', `Unknown spawn "${respawnSpawnId}" on "${respawnMapId}"`)
  }

  for (const [index, map] of maps.entries()) {
    const path = `world.maps[${index}]`
    uniqueBy(map.monsterGroups, (group) => `${group.monsterArchetypeId}:${group.level}`, `${path}.monsterGroups`, '')
    for (const [groupIndex, group] of map.monsterGroups.entries()) {
      reference(monsters, group.monsterArchetypeId, `${path}.monsterGroups[${groupIndex}].monsterArchetypeId`)
    }
    for (const [portalIndex, portal] of map.portals.entries()) {
      const portalPath = `${path}.portals[${portalIndex}]`
      const destination = reference(objectsByMap, portal.destinationMapId, `${portalPath}.destinationMapId`)
      reference(destination.spawns, portal.destinationSpawnId, `${portalPath}.destinationSpawnId`)
      const reverse = reference(destination.portals, portal.reversePortalId, `${portalPath}.reversePortalId`)
      if (portal.destinationMapId === map.id || reverse.destinationMapId !== map.id || reverse.reversePortalId !== portal.id) {
        invalid('INVALID_REFERENCE', `${portalPath}.reversePortalId`, `Expected a reciprocal portal back to "${map.id}/${portal.id}"`)
      }
    }
  }

  const reachable = new Set([respawnMapId])
  for (const mapId of reachable) {
    const map = reference(mapIndex, mapId, 'world.maps')
    for (const portal of map.portals) reachable.add(portal.destinationMapId)
  }
  for (const [index, map] of maps.entries()) {
    if (!reachable.has(map.id)) {
      invalid('INVALID_REFERENCE', `world.maps[${index}].id`, `Map "${map.id}" is unreachable from "${respawnMapId}"`)
    }
  }

  return {
    tileSizeWorldUnits,
    maxMonstersPerMap,
    respawn: { mapId: respawnMapId, spawnId: respawnSpawnId },
    maps: maps
      .sort((left, right) => compareIds(left.id, right.id))
      .map((map) => ({
        ...map,
        spawnIds: [...map.spawnIds].sort(compareIds),
        portals: [...map.portals].sort((left, right) => compareIds(left.id, right.id)),
        monsterGroups: [...map.monsterGroups].sort(
          (left, right) => compareIds(left.monsterArchetypeId, right.monsterArchetypeId) || left.level - right.level
        ),
      })),
  }
}

/** 將載入器排序的 manifest 序列化，供呼叫端以 UTF-8 計算 SHA-256。 */
export function serializeMapManifest({ world, tiledMaps }: GameData): string {
  const manifest = { tileSizeWorldUnits: world.tileSizeWorldUnits, respawn: world.respawn, maps: world.maps }
  return JSON.stringify(tiledMaps.length === 0 ? manifest : { ...manifest, tiledMaps })
}
