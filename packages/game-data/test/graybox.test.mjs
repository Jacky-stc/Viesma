import { initialPhysicsBalance, loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'

const sources = import.meta.glob('../src/maps/*.json', { eager: true, import: 'default' })
const exports = Object.entries(sources).map(([path, map]) => ({ mapId: path.split('/').at(-1).replace('.json', ''), map, tilesets: {} }))
const hash = (data) => createHash('sha256').update(serializeMapManifest(data), 'utf8').digest('hex')
const getMap = (maps, id) => maps.find((map) => map.id === id)

const expectedMaps = {
  village: { size: [96, 24], destinations: ['m1', 'm2', 'm3', 'm4'], monsters: [] },
  m1: { size: [128, 32], destinations: ['m5', 'village'], monsters: ['mushroom:4:4', 'slime:2:6'] },
  m2: { size: [160, 24], destinations: ['m6', 'village'], monsters: ['bat:7:2', 'mushroom:6:4', 'slime:4:4'] },
  m3: { size: [128, 48], destinations: ['village'], monsters: ['bat:10:4', 'mushroom:8:6', 'slime:6:2'] },
  m4: { size: [128, 40], destinations: ['village'], monsters: ['bat:13:8', 'mushroom:11:4'] },
  m5: { size: [160, 48], destinations: ['m1'], monsters: ['bat:19:4', 'mushroom:17:4', 'slime:15:4'] },
  m6: { size: [160, 40], destinations: ['m2'], monsters: ['bat:25:6', 'mushroom:22:4', 'slime:19:2'] },
}

test('imports seven Tiled maps and the exact directed topology with reciprocal portal and spawn IDs', () => {
  const data = loadGrayboxGameData()
  expect(data.world.respawn).toEqual({ mapId: 'village', spawnId: 'spawn_respawn' })
  expect(data.tiledMaps.map(({ id }) => id)).toEqual(Object.keys(expectedMaps).sort())
  expect(data.tiledMaps.flatMap(({ portals }) => portals)).toHaveLength(12)
  for (const map of data.tiledMaps) {
    const { size, destinations, monsters } = expectedMaps[map.id]
    expect([map.widthTiles, map.heightTiles]).toEqual(size)
    expect(map.portals.map(({ destinationMapId }) => destinationMapId)).toEqual(destinations)
    expect(map.spawns.map(({ id }) => id)).toEqual([
      ...destinations.map((id) => 'spawn_from_' + id),
      ...(map.id === 'village' ? ['spawn_respawn'] : []),
    ])
    expect(new Set(map.colliders.map(({ kind }) => kind))).toEqual(new Set(['solid', 'oneWay']))
    const groups = new Map()
    for (const spawn of map.monsterSpawns) {
      const key = spawn.monsterArchetypeId + ':' + spawn.level
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    expect([...groups].map(([group, count]) => group + ':' + count).sort()).toEqual(monsters)
    expect(map.lootFallbacks).toHaveLength(map.monsterSpawns.some(({ movement }) => movement === 'flight') ? 1 : 0)
    for (const portal of map.portals) {
      const destination = getMap(data.tiledMaps, portal.destinationMapId)
      expect(portal.id).toBe('p_to_' + destination.id)
      expect(portal.destinationSpawnId).toBe('spawn_from_' + map.id)
      expect(portal.reversePortalId).toBe('p_to_' + map.id)
      expect(destination.spawns.some(({ id }) => id === portal.destinationSpawnId)).toBe(true)
      expect(destination.portals.find(({ id }) => id === portal.reversePortalId)).toMatchObject({
        destinationMapId: map.id,
        destinationSpawnId: 'spawn_from_' + destination.id,
        reversePortalId: portal.id,
      })
    }
  }
  expect(data.tiledMaps.flatMap(({ spawns }) => spawns)).toHaveLength(13)
  const reached = new Set([data.world.respawn.mapId])
  for (const id of reached) for (const { destinationMapId } of getMap(data.tiledMaps, id).portals) reached.add(destinationMapId)
  expect(reached).toEqual(new Set(Object.keys(expectedMaps)))
})

test('all entry, return and respawn points rest on a support in the imported geometry', () => {
  const { bodyWidthWorldUnits: width, bodyHeightWorldUnits: height } = initialPhysicsBalance
  for (const map of loadGrayboxGameData().tiledMaps) {
    for (const {
      position: { x, y },
    } of map.spawns) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x + width).toBeLessThanOrEqual(map.bounds.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y + height).toBeLessThanOrEqual(map.bounds.height)
      expect(
        map.colliders.some(
          ({ bounds: { origin, width: supportWidth } }) => y + height === origin.y && x < origin.x + supportWidth && x + width > origin.x
        )
      ).toBe(true)
    }
  }
})

test('hashes the same normalized map content regardless of export and object order', () => {
  const reordered = globalThis.structuredClone(exports).reverse()
  for (const { map } of reordered) {
    map.layers.reverse()
    for (const layer of map.layers) layer.objects.reverse()
  }
  expect(hash(loadGrayboxGameData(reordered))).toBe(hash(loadGrayboxGameData()))
  reordered.find(({ mapId }) => mapId === 'm6').map.layers.find(({ name }) => name === 'Portals').objects[0].width -= 1
  expect(hash(loadGrayboxGameData(reordered))).not.toBe(hash(loadGrayboxGameData()))
})

test.each([
  [
    'unsupported spawn',
    'Player spawns',
    (objects) => {
      objects[0].y -= 1
    },
    'INVALID_VALUE',
  ],
  [
    'spawn in a trigger',
    'Player spawns',
    (objects) => {
      objects[0].x = 185
    },
    'INVALID_VALUE',
  ],
  [
    'out-of-bounds trigger',
    'Portals',
    (objects) => {
      objects[0].x = -1
    },
    'OUT_OF_RANGE',
  ],
  [
    'dangling destination map',
    'Portals',
    (objects) => {
      objects[0].properties.find(({ name }) => name === 'destinationMapId').value = 'missing_map'
    },
    'INVALID_REFERENCE',
  ],
  [
    'dangling spawn ID',
    'Portals',
    (objects) => {
      objects[0].properties.find(({ name }) => name === 'destinationSpawnId').value = 'missing_spawn'
    },
    'INVALID_REFERENCE',
  ],
  [
    'missing reverse portal',
    'Portals',
    (objects) => {
      objects.pop()
    },
    'MISSING_FIELD',
  ],
  [
    'missing spawn',
    'Player spawns',
    (objects) => {
      objects.pop()
    },
    'MISSING_FIELD',
  ],
  [
    'missing patrol marker',
    'Monster spawns',
    (objects) => {
      objects.shift()
    },
    'MISSING_FIELD',
  ],
])('rejects %s in the shipped world', (_label, layerName, edit, code) => {
  const input = globalThis.structuredClone(exports)
  edit(input.find(({ mapId }) => mapId === 'm6').map.layers.find(({ name }) => name === layerName).objects)
  expect(() => loadGrayboxGameData(input)).toThrow(expect.objectContaining({ code }))
})

test('requires all seven destination maps to be shipped', () => {
  expect(() => loadGrayboxGameData(exports.filter(({ mapId }) => mapId !== 'm6'))).toThrow(
    expect.objectContaining({ code: 'MISSING_FIELD', path: 'tiledMaps', message: expect.stringContaining('m6') })
  )
})

test('links immutable Guide dialogue and range to the normalized Village NPC point', () => {
  const data = loadGrayboxGameData()
  const village = getMap(data.tiledMaps, 'village')
  expect(data.guide).toMatchObject({ mapId: 'village', npc: { id: 'npc_guide' }, interactionDistanceWorldUnits: 96, title: 'Guide' })
  expect(data.guide.npc).toBe(village.npcs[0])
  expect(data.guide.lines).toHaveLength(5)
  expect(Object.isFrozen(data.guide.lines)).toBe(true)
})

test('updates the world hash when the Tiled Guide point moves', () => {
  const input = globalThis.structuredClone(exports)
  const { objects } = input.find(({ mapId }) => mapId === 'village').map.layers.find(({ name }) => name === 'NPCs')
  objects[0].x += 1
  const data = loadGrayboxGameData(input)
  expect(data.guide.npc.position.x).toBe(objects[0].x)
  expect(hash(data)).not.toBe(hash(loadGrayboxGameData()))
})

test.each(['missing', 'wrong ID', 'outside the map'])('rejects a Guide point that is %s in Village', (problem) => {
  const input = globalThis.structuredClone(exports)
  const { objects } = input.find(({ mapId }) => mapId === 'village').map.layers.find(({ name }) => name === 'NPCs')
  const [guide] = objects
  if (problem === 'missing') objects.pop()
  else if (problem === 'wrong ID') guide.name = 'another_npc'
  else guide.x = -1
  expect(() => loadGrayboxGameData(input)).toThrow(
    expect.objectContaining({ code: problem === 'outside the map' ? 'OUT_OF_RANGE' : 'INVALID_REFERENCE' })
  )
})
