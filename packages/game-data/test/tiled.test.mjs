import { fixedDeltaSeconds } from '@viesma/domain'
import { createInitialGameDataSource, initialPhysicsBalance, loadGameData, serializeMapManifest } from '@viesma/game-data'
import { createPhysicsStepper } from '@viesma/physics'
import { checkJoinVersion, PROTOCOL_VERSION } from '@viesma/protocol'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { expect, test, vi } from 'vitest'

function fixture(file) {
  return JSON.parse(readFileSync(new URL(`./fixtures/tiled/${file}`, import.meta.url), 'utf8'))
}

const hubId = 'fixture_hub'
const fieldId = 'fixture_field'
const hubFloor = 'tiledMaps[0].map.layers[1].objects[0]'
const hubSpawn = 'tiledMaps[0].map.layers[1].objects[2]'
const hubPortal = 'tiledMaps[0].map.layers[1].objects[4]'

function fixtures() {
  return [
    { mapId: hubId, map: fixture(`${hubId}.tmj`), tilesets: { 'swatches.tsj': fixture('swatches.tsj') } },
    { mapId: fieldId, map: fixture(`${fieldId}.tmj`), tilesets: {} },
  ]
}

function fixtureGameData() {
  const source = createInitialGameDataSource()
  const portal = (self, other) => ({
    id: `p_to_${other}`,
    destinationMapId: other,
    destinationSpawnId: `spawn_from_${self}`,
    reversePortalId: `p_to_${self}`,
  })
  source.world.respawn = { mapId: hubId, spawnId: 'spawn_respawn' }
  source.world.maps = [
    {
      id: hubId,
      name: 'Fixture Hub',
      widthTiles: 8,
      heightTiles: 5,
      recommendedLevels: null,
      spawnIds: ['spawn_respawn', `spawn_from_${fieldId}`],
      portals: [portal(hubId, fieldId)],
      monsterGroups: [],
    },
    {
      id: fieldId,
      name: 'Fixture Field',
      widthTiles: 8,
      heightTiles: 5,
      recommendedLevels: { min: 1, max: 3 },
      spawnIds: [`spawn_from_${hubId}`],
      portals: [portal(fieldId, hubId)],
      monsterGroups: [
        { monsterArchetypeId: 'slime', level: 2, count: 1 },
        { monsterArchetypeId: 'bat', level: 3, count: 1 },
      ],
    },
  ]
  return source
}

function version(data) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    balanceVersion: data.balanceVersion,
    mapContentHash: createHash('sha256').update(serializeMapManifest(data), 'utf8').digest('hex'),
  }
}

test('imports reciprocal maps with immutable M1.1 geometry and stable object IDs', () => {
  const exports = fixtures()
  const data = loadGameData(fixtureGameData(), exports)
  const [field, hub] = data.tiledMaps
  expect([field.id, hub.id]).toEqual([fieldId, hubId])
  expect(hub).toMatchObject({
    bounds: { origin: { x: 0, y: 0 }, width: 256, height: 160 },
    tileSizeWorldUnits: 32,
    colliders: [
      { id: 'floor', kind: 'solid', bounds: { origin: { x: 0, y: 128 }, width: 256, height: 32 } },
      { id: 'ledge', kind: 'oneWay', bounds: { origin: { x: 96, y: 96 }, width: 64, height: 6 } },
    ],
    spawns: [
      { id: 'spawn_from_fixture_field', position: { x: 166, y: 80 }, facing: 'right' },
      { id: 'spawn_respawn', position: { x: 28.5, y: 80 }, facing: 'right' },
    ],
    portals: [
      {
        id: 'p_to_fixture_field',
        destinationMapId: fieldId,
        destinationSpawnId: 'spawn_from_fixture_hub',
        reversePortalId: 'p_to_fixture_hub',
        bounds: { origin: { x: 216, y: 80 }, width: 32, height: 48 },
      },
    ],
    npcs: [{ id: 'npc_guide', position: { x: 72, y: 128 } }],
  })
  expect(field.monsterSpawns).toMatchObject([
    { id: 'bat_a', movement: 'flight', position: { x: 192, y: 36 }, flightBounds: { width: 48, height: 40 } },
    { id: 'slime_a', movement: 'ground', floorId: 'floor', patrolMinX: 32, patrolMaxX: 72 },
  ])
  expect(field.lootFallbacks).toEqual([{ id: 'loot_fallback', position: { x: 180, y: 128 } }])
  expect(field.spawns[0].position).toEqual({ x: 100, y: 48 })
  expect(hub.tileLayers[0].cells.slice(0, 5)).toEqual([
    { tileset: 'swatches.tsj', tileId: 0, flipHorizontal: true, flipVertical: false, flipDiagonal: false },
    { tileset: 'swatches.tsj', tileId: 1, flipHorizontal: false, flipVertical: true, flipDiagonal: false },
    { tileset: 'swatches.tsj', tileId: 0, flipHorizontal: false, flipVertical: false, flipDiagonal: true },
    { tileset: 'swatches.tsj', tileId: 1, flipHorizontal: true, flipVertical: true, flipDiagonal: true },
    null,
  ])
  exports[0].map.layers[1].objects[0].x = 123
  expect(hub.colliders[0].bounds.origin.x).toBe(0)
  expect(Object.isFrozen(hub.tileLayers[0].cells[0])).toBe(true)
  expect(Object.isFrozen(hub.spawns[0].position)).toBe(true)
})

test('feeds the imported data directly to physics and keeps one-way faces passable from below', () => {
  const data = loadGameData(fixtureGameData(), fixtures())
  const [field, hub] = data.tiledMaps
  const input = { horizontalSpeedUnitsPerSecond: 0, jumpPressed: false }
  const step = createPhysicsStepper(hub, initialPhysicsBalance)
  const body = (position, speedY = 0) => ({ bounds: { origin: position, width: 24, height: 48 }, velocity: { x: 0, y: speedY } })
  expect(step(body(hub.spawns[1].position), input, fixedDeltaSeconds)).toMatchObject({ grounded: true, inVoid: false })
  expect(step(body(field.spawns[0].position), input, fixedDeltaSeconds)).toMatchObject({ grounded: true, inVoid: false })
  expect(step(body({ x: 100, y: 68 }, -800), input, fixedDeltaSeconds).body.bounds.origin.y).toBeLessThan(48)
  expect(step(body({ x: 100, y: 38 }, 600), input, fixedDeltaSeconds)).toMatchObject({
    body: { bounds: { origin: { x: 100, y: 48 } } },
    grounded: true,
  })
})

test.each([
  ['zero width', 'OUT_OF_RANGE', 'tiledMaps[0].map.width', ({ map }) => (map.width = 0)],
  ['wrong tile height', 'OUT_OF_RANGE', 'tiledMaps[0].map.tileheight', ({ map }) => (map.tileheight = 16)],
  ['isometric map', 'UNSUPPORTED_TILED_FEATURE', 'tiledMaps[0].map.orientation', (entry) => (entry.map = fixture('unsupported.tmj'))],
  ['infinite map', 'UNSUPPORTED_TILED_FEATURE', 'tiledMaps[0].map.infinite', ({ map }) => (map.infinite = true)],
  ['future version', 'UNSUPPORTED_TILED_FEATURE', 'tiledMaps[0].map.version', ({ map }) => (map.version = '2.0')],
  ['group layer', 'UNSUPPORTED_TILED_FEATURE', 'tiledMaps[0].map.layers[0].type', ({ map }) => (map.layers[0].type = 'group')],
  ['base64 data', 'UNSUPPORTED_TILED_FEATURE', 'tiledMaps[0].map.layers[0].encoding', ({ map }) => (map.layers[0].encoding = 'base64')],
  ['short layer', 'OUT_OF_RANGE', 'tiledMaps[0].map.layers[0].data', ({ map }) => map.layers[0].data.pop()],
  ['duplicate layer ID', 'DUPLICATE_ID', 'tiledMaps[0].map.layers[1].id', ({ map }) => (map.layers[1].id = 1)],
  ['missing tileset', 'UNKNOWN_REFERENCE', 'tiledMaps[0].map.tilesets[0].source', ({ tilesets }) => delete tilesets['swatches.tsj']],
  [
    'broken atlas',
    'INVALID_VALUE',
    'tiledMaps[0].tilesets["swatches.tsj"].tilecount',
    ({ tilesets }) => (tilesets['swatches.tsj'] = fixture('broken-atlas.tsj')),
  ],
  ['wrong GID span', 'UNKNOWN_REFERENCE', 'tiledMaps[0].map.layers[0].data[0]', ({ map }) => (map.layers[0].data[0] = 0x80000003)],
  ['signed GID', 'OUT_OF_RANGE', 'tiledMaps[0].map.layers[0].data[0]', ({ map }) => (map.layers[0].data[0] = -1)],
  ['rotation', 'UNSUPPORTED_TILED_FEATURE', `${hubFloor}.rotation`, ({ map }) => (map.layers[1].objects[0].rotation = 10)],
  ['polygon', 'UNSUPPORTED_TILED_FEATURE', `${hubFloor}.polygon`, ({ map }) => (map.layers[1].objects[0].polygon = [])],
  ['out-of-bounds geometry', 'OUT_OF_RANGE', `${hubFloor}.height`, ({ map }) => (map.layers[1].objects[0].height = 40)],
  ['nonfinite geometry', 'OUT_OF_RANGE', `${hubFloor}.y`, ({ map }) => (map.layers[1].objects[0].y = Infinity)],
  ['off-grid geometry', 'OUT_OF_RANGE', `${hubFloor}.y`, ({ map }) => (map.layers[1].objects[0].y = 128.001)],
  ['invalid one-way', 'OUT_OF_RANGE', 'tiledMaps[0].map.layers[1].objects[1].height', ({ map }) => (map.layers[1].objects[1].height = 0)],
  ['duplicate Tiled ID', 'DUPLICATE_ID', `${hubSpawn}.id`, ({ map }) => (map.layers[1].objects[2].id = 1)],
  [
    'duplicate stable spawn ID',
    'DUPLICATE_ID',
    'tiledMaps[0].map.layers[1].objects[3].properties[spawnId]',
    ({ map }) => (map.layers[1].objects[3].properties[0].value = 'spawn_respawn'),
  ],
  ['missing facing', 'MISSING_FIELD', `${hubSpawn}.properties[facing]`, ({ map }) => map.layers[1].objects[2].properties.pop()],
  [
    'wrong facing type',
    'INVALID_TYPE',
    `${hubSpawn}.properties[1].type`,
    ({ map }) => {
      map.layers[1].objects[2].properties[1].type = 'int'
      map.layers[1].objects[2].properties[1].value = 1
    },
  ],
  [
    'unknown spawn ID',
    'UNKNOWN_REFERENCE',
    `${hubSpawn}.properties[spawnId]`,
    ({ map }) => (map.layers[1].objects[2].properties[0].value = 'missing'),
  ],
  ['missing spawn object', 'MISSING_FIELD', 'tiledMaps[0].map.layers', ({ map }) => map.layers[1].objects.splice(2, 1)],
  ['missing reverse object', 'MISSING_FIELD', 'tiledMaps[0].map.layers', ({ map }) => map.layers[1].objects.splice(4, 1)],
  ['unsupported spawn', 'INVALID_VALUE', hubSpawn, ({ map }) => (map.layers[1].objects[2].y = 127)],
  [
    'spawn without solid headroom',
    'INVALID_VALUE',
    hubSpawn,
    ({ map }) => map.layers[1].objects.push({ ...map.layers[1].objects[0], id: 7, name: 'ceiling', x: 28, y: 65, width: 16, height: 16 }),
  ],
  ['spawn inside portal', 'INVALID_VALUE', hubSpawn, ({ map }) => (map.layers[1].objects[2].x = 230)],
  ['portal crossing solid floor', 'INVALID_VALUE', hubPortal, ({ map }) => (map.layers[1].objects[4].y = 81)],
  ['portal crossing one-way top', 'INVALID_VALUE', hubPortal, ({ map }) => (map.layers[1].objects[4].x = 110)],
  ['out-of-bounds portal', 'OUT_OF_RANGE', `${hubPortal}.width`, ({ map }) => (map.layers[1].objects[4].x = 230)],
  [
    'wrong portal target',
    'INVALID_REFERENCE',
    `${hubPortal}.properties[destinationMapId]`,
    ({ map }) => (map.layers[1].objects[4].properties[1].value = 'm6'),
  ],
  [
    'wrong portal spawn',
    'INVALID_REFERENCE',
    `${hubPortal}.properties[destinationSpawnId]`,
    ({ map }) => (map.layers[1].objects[4].properties[2].value = 'missing'),
  ],
  [
    'wrong reverse portal',
    'INVALID_REFERENCE',
    `${hubPortal}.properties[reversePortalId]`,
    ({ map }) => (map.layers[1].objects[4].properties[3].value = 'missing'),
  ],
  ['mismatched map ID', 'INVALID_REFERENCE', 'tiledMaps[0].map.properties[mapId]', ({ map }) => (map.properties[0].value = fieldId)],
])('rejects %s before a map can reach physics initialization', (_, code, path, mutate) => {
  const exports = fixtures()
  mutate(exports[0])
  const initialize = vi.fn(createPhysicsStepper)
  expect(() => initialize(loadGameData(fixtureGameData(), exports).tiledMaps[0], initialPhysicsBalance)).toThrow(
    expect.objectContaining({ code, path })
  )
  expect(initialize).not.toHaveBeenCalled()
})

test.each([
  ['missing ground floor', 'UNKNOWN_REFERENCE', (objects) => (objects[4].properties[3].value = 'missing')],
  ['patrol outside floor', 'INVALID_VALUE', (objects) => (objects[4].properties[4].value = -1)],
  ['unexpected monster level', 'UNKNOWN_REFERENCE', (objects) => (objects[4].properties[2].value = 3)],
  ['obstructed flight bounds', 'INVALID_VALUE', (objects) => (objects[5].y = 100)],
  ['unsafe loot fallback', 'INVALID_VALUE', (objects) => (objects[6].y = 130)],
  ['missing loot fallback for flight', 'MISSING_FIELD', (objects) => objects.pop()],
])('rejects %s', (_, code, mutate) => {
  const exports = fixtures()
  mutate(exports[1].map.layers[0].objects)
  expect(() => loadGameData(fixtureGameData(), exports)).toThrow(
    expect.objectContaining({ code, path: expect.stringMatching(/^tiledMaps\[1\]/) })
  )
})

test('normalizes GID allocation, key order and object order while preserving meaningful drawing order', () => {
  const exports = fixtures()
  const { layers, tilesets } = exports[0].map
  layers.splice(1, 0, { ...layers[0], id: 8, name: 'Upper terrain', data: Array(40).fill(0) })
  exports[0].tilesets['other.tsj'] = { ...exports[0].tilesets['swatches.tsj'] }
  tilesets.push({ firstgid: 3, source: 'other.tsj' })
  const data = loadGameData(fixtureGameData(), exports)
  const reordered = JSON.parse(
    JSON.stringify(exports, (_, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).reverse())
      return value
    })
  )
  reordered.reverse()
  const map = reordered[1].map
  map.layers[2].objects.reverse()
  for (const object of map.layers[2].objects) object.properties?.reverse()
  for (const layer of map.layers) layer.id += 10
  map.tilesets[0].firstgid = 3
  map.tilesets[1].firstgid = 1
  map.tilesets.reverse()
  map.layers[0].data = map.layers[0].data.map((raw) => (raw ? raw + 2 : 0))
  const equivalent = loadGameData(fixtureGameData(), reordered)
  expect(equivalent).toEqual(data)
  expect(version(equivalent)).toEqual(version(data))
  map.layers.splice(0, 2, map.layers[1], map.layers[0])
  expect(version(loadGameData(fixtureGameData(), reordered)).mapContentHash).not.toBe(version(data).mapContentHash)
})

test('retains the manifest-only hash format and uses the existing join check for changed gameplay geometry', () => {
  const source = fixtureGameData()
  const exports = fixtures()
  const base = loadGameData(source)
  expect(base.tiledMaps).toEqual([])
  expect(serializeMapManifest(base)).toBe(
    JSON.stringify({
      tileSizeWorldUnits: base.world.tileSizeWorldUnits,
      respawn: base.world.respawn,
      maps: base.world.maps,
    })
  )
  const loaded = loadGameData(source, exports)
  const server = version(loaded)
  expect(server.mapContentHash).not.toBe(version(base).mapContentHash)
  expect(loaded.schemaVersion).toBe(base.schemaVersion)
  expect(server.balanceVersion).toBe(base.balanceVersion)
  expect(checkJoinVersion(server, version(loadGameData(source, fixtures())))).toEqual({ ok: true })
  for (const change of [
    (map) => (map.layers[1].objects[1].height += 1),
    (map) => (map.layers[1].objects[2].x += 1),
    (map) => (map.layers[1].objects[4].width -= 1),
  ]) {
    const changed = fixtures()
    change(changed[0].map)
    expect(checkJoinVersion(server, version(loadGameData(source, changed)))).toEqual({
      ok: false,
      code: 'MAP_CONTENT_HASH_MISMATCH',
    })
  }
})

test('accepts a valid authored subset of the existing seven-map manifest and rejects unknown and duplicate maps', () => {
  const source = createInitialGameDataSource()
  const manifest = source.world.maps.find(({ id }) => id === 'village')
  const [{ map }] = fixtures()
  const layer = map.layers[1]
  const groundY = (manifest.heightTiles - 1) * 32
  const colliders = [{ ...layer.objects[0], width: manifest.widthTiles * 32, y: groundY }]
  const spawns = manifest.spawnIds.map((id, index) => ({
    ...layer.objects[2],
    id: index + 2,
    x: 40 + 40 * index,
    y: groundY,
    properties: [{ name: 'spawnId', type: 'string', value: id }, layer.objects[2].properties[1]],
  }))
  const portals = manifest.portals.map(({ id, ...destination }, index) => ({
    ...layer.objects[4],
    id: index + 2 + spawns.length,
    x: 320 + 40 * index,
    y: groundY - 48,
    properties: Object.entries({ portalId: id, ...destination }).map(([name, value]) => ({ name, type: 'string', value })),
  }))
  Object.assign(map, {
    width: manifest.widthTiles,
    height: manifest.heightTiles,
    layers: [{ ...layer, objects: [...colliders, ...spawns, ...portals] }],
    properties: [{ name: 'mapId', type: 'string', value: 'village' }],
    tilesets: [],
  })
  const entry = { mapId: 'village', map, tilesets: {} }
  const data = loadGameData(source, [entry])
  expect(data.world.maps).toHaveLength(7)
  expect(data.tiledMaps.map(({ id }) => id)).toEqual(['village'])
  expect(data.tiledMaps[0].portals).toHaveLength(4)
  expect(() => loadGameData(source, [entry, entry])).toThrow(expect.objectContaining({ code: 'DUPLICATE_ID', path: 'tiledMaps[1].mapId' }))
  expect(() => loadGameData(source, [{ ...entry, mapId: 'm7' }])).toThrow(
    expect.objectContaining({ code: 'UNKNOWN_REFERENCE', path: 'tiledMaps[0].mapId' })
  )
})
