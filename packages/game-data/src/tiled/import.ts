import { fixedDeltaSeconds, type MapId } from '@viesma/domain'
import { maxWorldCoordinate, type Aabb } from '@viesma/physics'
import { initialPhysicsBalance } from '../initial-physics.js'
import type { MapDefinition, MonsterArchetypeId, MonsterDefinition, WorldDefinition } from '../types.js'
import { array, choice, compareIds, fields, id, integer, invalid, name, object, reference } from '../validation.js'
import { boolean, defaultOnly, properties, property, propertyFields, tiledRecord, tiledVersion, unsupported } from './format.js'
import { parseMapObject, type LocatedMapObject } from './objects.js'
import { resolveTilesets } from './tiles.js'
import type { MapCollider, MapMonsterSpawn, MapPlayerSpawn, MapPoint, MapPortal, NormalizedMap, NormalizedTileLayer } from './types.js'
import { validateMap } from './validate-map.js'

function mapBounds(width: number, height: number, tileSize: number, path: string): Aabb {
  const widthUnits = width * tileSize
  const heightUnits = height * tileSize
  if (widthUnits > maxWorldCoordinate) invalid('OUT_OF_RANGE', `${path}.width`, 'Map exceeds M1.1 world width')
  const { voidDepthWorldUnits, terminalFallSpeedUnitsPerSecond } = initialPhysicsBalance
  if (heightUnits + voidDepthWorldUnits + Math.ceil(terminalFallSpeedUnitsPerSecond * fixedDeltaSeconds) > maxWorldCoordinate) {
    invalid('OUT_OF_RANGE', `${path}.height`, 'Map and void fall exceed the M1.1 coordinate limit')
  }
  return { origin: { x: 0, y: 0 }, width: widthUnits, height: heightUnits }
}

function importMap(
  input: unknown,
  files: unknown,
  manifest: MapDefinition,
  tileSize: number,
  monsters: ReadonlyMap<MonsterArchetypeId, MonsterDefinition>,
  levelCap: number,
  path: string
): NormalizedMap {
  const mapPath = `${path}.map`
  const source = tiledRecord(
    input,
    mapPath,
    [
      'type',
      'version',
      'tiledversion',
      'orientation',
      'infinite',
      'width',
      'height',
      'tilewidth',
      'tileheight',
      'layers',
      'tilesets',
      'properties',
    ],
    ['class', 'renderorder', 'compressionlevel', 'nextlayerid', 'nextobjectid', 'parallaxoriginx', 'parallaxoriginy']
  )
  tiledVersion(source, mapPath)
  if (source.type !== 'map') unsupported(`${mapPath}.type`, 'Expected a Tiled map')
  if (source.orientation !== 'orthogonal') unsupported(`${mapPath}.orientation`, 'Only orthogonal maps are supported')
  if (source.infinite !== false) unsupported(`${mapPath}.infinite`, 'Only finite maps are supported')
  defaultOnly(source.class, `${mapPath}.class`, '')
  defaultOnly(source.renderorder, `${mapPath}.renderorder`, 'right-down')
  defaultOnly(source.parallaxoriginx, `${mapPath}.parallaxoriginx`, 0)
  defaultOnly(source.parallaxoriginy, `${mapPath}.parallaxoriginy`, 0)
  const propsPath = `${mapPath}.properties`
  const props = properties(source.properties, propsPath)
  propertyFields(props, propsPath, ['mapId'])
  if (property(props, propsPath, 'mapId', ['string'], id<MapId>) !== manifest.id) {
    invalid('INVALID_REFERENCE', `${propsPath}[mapId]`, `Expected map ID "${manifest.id}"`)
  }
  const widthTiles = integer(source.width, `${mapPath}.width`, manifest.widthTiles, manifest.widthTiles)
  const heightTiles = integer(source.height, `${mapPath}.height`, manifest.heightTiles, manifest.heightTiles)
  integer(source.tilewidth, `${mapPath}.tilewidth`, tileSize, tileSize)
  integer(source.tileheight, `${mapPath}.tileheight`, tileSize, tileSize)
  const bounds = mapBounds(widthTiles, heightTiles, tileSize, mapPath)
  const { tilesets, decode } = resolveTilesets(source.tilesets, files, path, tileSize)
  const tileLayers: NormalizedTileLayer[] = []
  const layerIds = new Set<number>()
  const objectIds = new Set<number>()
  const objects: LocatedMapObject[] = []
  const layers = array(source.layers, `${mapPath}.layers`, (input, path) => ({ layer: object(input, path), path }))
  for (const { layer, path: layerPath } of layers) {
    if (layer.type !== 'tilelayer' && layer.type !== 'objectgroup') {
      unsupported(`${layerPath}.type`, 'Only tile layers and object layers are supported')
    }
    const optional = ['class', 'locked', 'opacity', 'visible', 'offsetx', 'offsety', 'parallaxx', 'parallaxy', 'mode', 'properties']
    if (layer.type === 'tilelayer') {
      fields(
        layer,
        layerPath,
        ['type', 'id', 'name', 'width', 'height', 'x', 'y', 'data'],
        [...optional, 'encoding', 'compression', 'chunks']
      )
    } else {
      fields(layer, layerPath, ['type', 'id', 'name', 'x', 'y', 'objects'], [...optional, 'width', 'height', 'draworder'])
    }
    const layerId = integer(layer.id, `${layerPath}.id`, 1)
    if (layerIds.has(layerId)) invalid('DUPLICATE_ID', `${layerPath}.id`, `Duplicate Tiled layer ID ${layerId}`)
    layerIds.add(layerId)
    const layerName = name(layer.name, `${layerPath}.name`)
    for (const key of ['x', 'y', 'offsetx', 'offsety']) defaultOnly(layer[key], `${layerPath}.${key}`, 0)
    for (const key of ['parallaxx', 'parallaxy']) defaultOnly(layer[key], `${layerPath}.${key}`, 1)
    defaultOnly(layer.class, `${layerPath}.class`, '')
    defaultOnly(layer.mode, `${layerPath}.mode`, 'normal')
    propertyFields(properties(layer.properties, `${layerPath}.properties`), `${layerPath}.properties`, [])
    if (layer.locked !== undefined) boolean(layer.locked, `${layerPath}.locked`)
    const visible = layer.visible === undefined ? true : boolean(layer.visible, `${layerPath}.visible`)
    const opacity = layer.opacity === undefined ? 1 : layer.opacity
    if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      invalid('OUT_OF_RANGE', `${layerPath}.opacity`, 'Expected opacity from 0 to 1')
    }
    if (layer.type === 'tilelayer') {
      defaultOnly(layer.encoding, `${layerPath}.encoding`, 'csv')
      defaultOnly(layer.compression, `${layerPath}.compression`, '')
      if (Object.hasOwn(layer, 'chunks')) unsupported(`${layerPath}.chunks`, 'Chunked tile data is unsupported')
      integer(layer.width, `${layerPath}.width`, widthTiles, widthTiles)
      integer(layer.height, `${layerPath}.height`, heightTiles, heightTiles)
      const cellCount = widthTiles * heightTiles
      const cells = array(layer.data, `${layerPath}.data`, decode, cellCount, cellCount)
      tileLayers.push({ name: layerName, visible, opacity: opacity || 0, cells })
    } else {
      if (layer.draworder !== undefined) choice(layer.draworder, `${layerPath}.draworder`, ['index', 'topdown'])
      defaultOnly(layer.width, `${layerPath}.width`, 0)
      defaultOnly(layer.height, `${layerPath}.height`, 0)
      for (const entry of array(layer.objects, `${layerPath}.objects`, (value, objectPath) =>
        parseMapObject(value, objectPath, bounds, objectIds, monsters, levelCap)
      )) {
        objects.push(entry)
      }
    }
  }

  const colliders: MapCollider[] = []
  const spawns: MapPlayerSpawn[] = []
  const portals: MapPortal[] = []
  const monsterSpawns: MapMonsterSpawn[] = []
  const npcs: MapPoint[] = []
  const lootFallbacks: MapPoint[] = []
  const objectPaths = new Map<string, string>()
  for (const { kind, value, path: objectPath } of objects.sort((a, b) => compareIds(a.value.id, b.value.id))) {
    const key = `${kind === 'monster' ? 'spawn' : kind}:${value.id}`
    if (objectPaths.has(key)) {
      const idField = kind === 'spawn' || kind === 'monster' ? 'properties[spawnId]' : kind === 'portal' ? 'properties[portalId]' : 'name'
      invalid('DUPLICATE_ID', `${objectPath}.${idField}`, `Duplicate ID "${value.id}"`)
    }
    objectPaths.set(key, objectPath)
    switch (kind) {
      case 'collider':
        colliders.push(value)
        break
      case 'spawn':
        spawns.push(value)
        break
      case 'portal':
        portals.push(value)
        break
      case 'monster':
        monsterSpawns.push(value)
        break
      case 'npc':
        npcs.push(value)
        break
      case 'loot':
        lootFallbacks.push(value)
        break
    }
  }
  const map: NormalizedMap = {
    id: manifest.id,
    widthTiles,
    heightTiles,
    tileSizeWorldUnits: tileSize,
    bounds,
    voidDepthWorldUnits: initialPhysicsBalance.voidDepthWorldUnits,
    tilesets,
    tileLayers,
    colliders,
    spawns,
    portals,
    monsterSpawns,
    npcs,
    lootFallbacks,
  }
  validateMap(map, manifest, `${mapPath}.layers`, (kind, key) =>
    reference(objectPaths, `${kind === 'monster' ? 'spawn' : kind}:${key}`, mapPath)
  )
  return map
}

/** 將已解碼的 Tiled 匯出與外部 tileset 轉成可直接交給 M1.1 的資料。 */
export function importTiledMaps(
  input: unknown,
  world: WorldDefinition,
  monsters: ReadonlyMap<MonsterArchetypeId, MonsterDefinition>,
  levelCap: number
): readonly NormalizedMap[] {
  const manifest = new Map(world.maps.map((map) => [map.id, map]))
  const seen = new Set<MapId>()
  return array(input, 'tiledMaps', (entry, path) => {
    const source = tiledRecord(entry, path, ['mapId', 'map', 'tilesets'])
    const mapId = id<MapId>(source.mapId, `${path}.mapId`)
    if (seen.has(mapId)) invalid('DUPLICATE_ID', `${path}.mapId`, `Duplicate map "${mapId}"`)
    const expected = reference(manifest, mapId, `${path}.mapId`)
    seen.add(mapId)
    return importMap(source.map, source.tilesets, expected, world.tileSizeWorldUnits, monsters, levelCap, path)
  }).sort((a, b) => compareIds(a.id, b.id))
}
