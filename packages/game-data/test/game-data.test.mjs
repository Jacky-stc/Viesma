import {
  createInitialGameDataSource,
  initialPhysicsBalance,
  loadGameData,
  loadPlayerMovementBalance,
  serializeMapManifest,
} from '@viesma/game-data'
import { checkJoinVersion, PROTOCOL_VERSION } from '@viesma/protocol'
import { Buffer } from 'node:buffer'
import { createHash, webcrypto } from 'node:crypto'
import { TextEncoder } from 'node:util'
import { expect, test } from 'vitest'

function mapHash(data) {
  return createHash('sha256').update(serializeMapManifest(data), 'utf8').digest('hex')
}

test('validates the documented controller defaults under the existing balance version', () => {
  const balance = loadPlayerMovementBalance(initialPhysicsBalance)
  expect(balance.balanceVersion).toBe(loadGameData(createInitialGameDataSource()).balanceVersion)
  expect(balance).toMatchObject({
    accelerationUnitsPerSecondSquared: 1800,
    groundDecelerationUnitsPerSecondSquared: 2200,
    jumpBufferTicks: 3,
    coyoteTimeTicks: 3,
    hurtTicks: 6,
  })
  expect(Object.isFrozen(balance)).toBe(true)
})

test.each([
  ['accelerationUnitsPerSecondSquared', NaN],
  ['groundDecelerationUnitsPerSecondSquared', 0],
  ['jumpBufferTicks', -1],
  ['coyoteTimeTicks', 1.5],
  ['hurtTicks', 0],
])('rejects invalid controller balance %s', (field, value) => {
  expect(() => loadPlayerMovementBalance({ ...initialPhysicsBalance, [field]: value })).toThrow(
    expect.objectContaining({ code: 'OUT_OF_RANGE', path: `movement.${field}` })
  )
})

test('loads the documented progression, world and reward fixtures', () => {
  const data = loadGameData(createInitialGameDataSource())
  expect(data.progression).toMatchObject({ levelCap: 25, apPerLevel: 5, totalExpToCap: 260_000, maxAp: 120 })
  expect(data.progression.expToNextLevel).toHaveLength(24)
  expect(data.progression.expToNextLevel).toEqual(Array.from({ length: 24 }, (_, index) => 50 * (index + 1) * (index + 2)))

  expect(Object.fromEntries(data.world.maps.map((map) => [map.id, map.portals.map((portal) => portal.destinationMapId)]))).toEqual({
    m1: ['m5', 'village'],
    m2: ['m6', 'village'],
    m3: ['village'],
    m4: ['village'],
    m5: ['m1'],
    m6: ['m2'],
    village: ['m1', 'm2', 'm3', 'm4'],
  })
  expect(data.world.maps.map((map) => map.monsterGroups.reduce((sum, group) => sum + group.count, 0))).toEqual([10, 10, 12, 12, 12, 12, 0])
  expect(data.world.respawn).toEqual({ mapId: 'village', spawnId: 'spawn_respawn' })
  expect(data.equipmentTiers.map(({ level }) => level)).toEqual([1, 5, 10, 15, 20, 25])
  expect(data.items.find(({ id }) => id === 'training_sword')).toMatchObject({
    kind: 'equipment',
    slot: 'weapon',
    modifiers: { attackPower: 3 },
    maxStack: 1,
  })
  expect(data.lootTables[0].entries.map(({ chanceBps }) => chanceBps)).toEqual([10_000, 3_000, 1_500, 6_000, 500])
})

test.each([
  [
    'schema version',
    'UNSUPPORTED_SCHEMA',
    'schemaVersion',
    (data) => {
      data.schemaVersion = 2
    },
  ],
  [
    'string schema version',
    'UNSUPPORTED_SCHEMA',
    'schemaVersion',
    (data) => {
      data.schemaVersion = '1'
    },
  ],
  [
    'missing field',
    'MISSING_FIELD',
    'world.maps[0].widthTiles',
    (data) => {
      delete data.world.maps[0].widthTiles
    },
  ],
  [
    'wrong type',
    'INVALID_TYPE',
    'world.maps',
    (data) => {
      data.world.maps = {}
    },
  ],
  [
    'unknown field',
    'UNKNOWN_FIELD',
    'world.maps[0].typo',
    (data) => {
      data.world.maps[0].typo = 1
    },
  ],
  [
    'duplicate map',
    'DUPLICATE_ID',
    'world.maps[7].id',
    (data) => {
      data.world.maps.push(data.world.maps[0])
    },
  ],
  [
    'duplicate item',
    'DUPLICATE_ID',
    'items[1].id',
    (data) => {
      data.items[1].id = data.items[0].id
    },
  ],
  [
    'duplicate monster',
    'DUPLICATE_ID',
    'monsters[1].id',
    (data) => {
      data.monsters[1].id = data.monsters[0].id
    },
  ],
  [
    'duplicate loot entry',
    'DUPLICATE_ID',
    'lootTables[0].entries[1].id',
    (data) => {
      data.lootTables[0].entries[1].id = data.lootTables[0].entries[0].id
    },
  ],
  [
    'duplicate portal',
    'DUPLICATE_ID',
    'world.maps[0].portals[1].id',
    (data) => {
      data.world.maps[0].portals[1].id = data.world.maps[0].portals[0].id
    },
  ],
  [
    'duplicate spawn',
    'DUPLICATE_ID',
    'world.maps[0].spawnIds[1]',
    (data) => {
      data.world.maps[0].spawnIds[1] = data.world.maps[0].spawnIds[0]
    },
  ],
  [
    'unknown monster',
    'UNKNOWN_REFERENCE',
    'world.maps[1].monsterGroups[0].monsterArchetypeId',
    (data) => {
      data.world.maps[1].monsterGroups[0].monsterArchetypeId = 'dragon'
    },
  ],
  [
    'unknown item',
    'UNKNOWN_REFERENCE',
    'lootTables[0].entries[1].itemId',
    (data) => {
      data.lootTables[0].entries[1].itemId = 'missing'
    },
  ],
  [
    'unknown loot table',
    'UNKNOWN_REFERENCE',
    'monsters[0].lootTableId',
    (data) => {
      data.monsters[0].lootTableId = 'missing'
    },
  ],
  [
    'non-material item',
    'INVALID_REFERENCE',
    'monsters[0].materialItemId',
    (data) => {
      data.monsters[0].materialItemId = 'hp_potion'
    },
  ],
  [
    'unknown map',
    'UNKNOWN_REFERENCE',
    'world.maps[0].portals[0].destinationMapId',
    (data) => {
      data.world.maps[0].portals[0].destinationMapId = 'm7'
    },
  ],
  [
    'unknown destination spawn',
    'UNKNOWN_REFERENCE',
    'world.maps[0].portals[0].destinationSpawnId',
    (data) => {
      data.world.maps[0].portals[0].destinationSpawnId = 'missing_spawn'
    },
  ],
  [
    'nonreciprocal portal',
    'INVALID_REFERENCE',
    'world.maps[0].portals[0].reversePortalId',
    (data) => {
      data.world.maps[0].portals[0].reversePortalId = 'p_to_m5'
    },
  ],
  [
    'unreachable map',
    'INVALID_REFERENCE',
    'world.maps[3].id',
    (data) => {
      data.world.maps[0].portals = data.world.maps[0].portals.filter(({ destinationMapId }) => destinationMapId !== 'm3')
      data.world.maps[3].portals = []
    },
  ],
  [
    'unsafe respawn map',
    'INVALID_REFERENCE',
    'world.respawn.mapId',
    (data) => {
      data.world.respawn.mapId = 'm1'
    },
  ],
  [
    'monsters in Village',
    'INVALID_VALUE',
    'world.maps[0].monsterGroups',
    (data) => {
      data.world.maps[0].monsterGroups = data.world.maps[1].monsterGroups
    },
  ],
  [
    'too many monsters',
    'OUT_OF_RANGE',
    'world.maps[1].monsterGroups',
    (data) => {
      data.world.maps[1].monsterGroups[0].count = 12
    },
  ],
  [
    'negative integer',
    'OUT_OF_RANGE',
    'monsters[0].baseDefense',
    (data) => {
      data.monsters[0].baseDefense = -1
    },
  ],
  [
    'fractional integer',
    'OUT_OF_RANGE',
    'world.maps[0].widthTiles',
    (data) => {
      data.world.maps[0].widthTiles = 1.5
    },
  ],
  [
    'unsafe integer',
    'OUT_OF_RANGE',
    'monsters[0].baseExp',
    (data) => {
      data.monsters[0].baseExp = Number.MAX_SAFE_INTEGER + 1
    },
  ],
  [
    'nonfinite integer',
    'OUT_OF_RANGE',
    'progression.apPerLevel',
    (data) => {
      data.progression.apPerLevel = Infinity
    },
  ],
  [
    'scaled stat overflow',
    'OVERFLOW',
    'monsters[0].baseHp',
    (data) => {
      data.monsters[0].baseHp = 2_147_483_647
    },
  ],
  [
    'reward arithmetic overflow',
    'OVERFLOW',
    'monsters[0].baseExp',
    (data) => {
      data.monsters[0].baseHp = 400_000_000
      data.monsters[0].baseExp = 1_000_000
    },
  ],
  [
    'wrong EXP row',
    'INVALID_CURVE',
    'progression.expToNextLevel[0]',
    (data) => {
      data.progression.expToNextLevel[0] = 200
    },
  ],
  [
    'missing EXP row',
    'OUT_OF_RANGE',
    'progression.expToNextLevel',
    (data) => {
      data.progression.expToNextLevel.pop()
    },
  ],
  [
    'EXP formula overflow',
    'OVERFLOW',
    'progression.expToNextLevel[0]',
    (data) => {
      data.progression.expCoefficient = 2_147_483_647
    },
  ],
  [
    'cumulative EXP overflow',
    'OVERFLOW',
    'progression.expToNextLevel[22]',
    (data) => {
      data.progression.expCoefficient = 500_000
      data.progression.expToNextLevel = data.progression.expToNextLevel.map((entry) => entry * 10_000)
    },
  ],
  [
    'AP overflow',
    'OVERFLOW',
    'progression.apPerLevel',
    (data) => {
      data.progression.apPerLevel = 2_147_483_647
    },
  ],
  [
    'currency overflow',
    'OVERFLOW',
    'lootTables[0].entries[0].maxPerLevel',
    (data) => {
      data.lootTables[0].entries[0].maxPerLevel = 100_000_000
    },
  ],
  [
    'invalid equipment slot',
    'INVALID_VALUE',
    'items[5].slot',
    (data) => {
      data.items[5].slot = 'ring'
    },
  ],
  [
    'wrong equipment tier reference',
    'INVALID_REFERENCE',
    'equipmentTiers[0].itemsBySlot.weapon',
    (data) => {
      data.equipmentTiers[0].itemsBySlot.weapon = 'armor_tier_1'
    },
  ],
  [
    'overstacked equipment',
    'OUT_OF_RANGE',
    'items[5].maxStack',
    (data) => {
      data.items[5].maxStack = 2
    },
  ],
  [
    'invalid modifier',
    'OUT_OF_RANGE',
    'items[5].modifiers.attackPower',
    (data) => {
      data.items[5].modifiers.attackPower = -3
    },
  ],
  [
    'invalid probability',
    'OUT_OF_RANGE',
    'lootTables[0].entries[0].chanceBps',
    (data) => {
      data.lootTables[0].entries[0].chanceBps = 10_001
    },
  ],
  [
    'reversed quantity range',
    'OUT_OF_RANGE',
    'lootTables[0].entries[3].maxQuantity',
    (data) => {
      data.lootTables[0].entries[3].maxQuantity = 0
    },
  ],
  [
    'material stack overflow',
    'INVALID_REFERENCE',
    'monsters[0].lootTableId',
    (data) => {
      data.items[2].maxStack = 1
    },
  ],
  [
    'empty loot table',
    'OUT_OF_RANGE',
    'lootTables[0].entries',
    (data) => {
      data.lootTables[0].entries = []
    },
  ],
])('rejects %s with a field path', (_, code, path, mutate) => {
  const source = createInitialGameDataSource()
  mutate(source)
  expect(() => loadGameData(source)).toThrow(expect.objectContaining({ name: 'GameDataValidationError', code, path }))
})

test('rejects an incompatible version before interpreting the document shape', () => {
  expect(() => loadGameData({ schemaVersion: 0, legacyField: true })).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA', path: 'schemaVersion' })
  )
})

test('returns independent, deeply immutable values', () => {
  const source = createInitialGameDataSource()
  const loaded = loadGameData(source)
  const original = loadGameData(createInitialGameDataSource())
  source.world.maps[0].portals[0].destinationSpawnId = 'edited'
  source.progression.expToNextLevel[0] = 123
  source.items[5].modifiers.attackPower = 999
  expect(loaded).toEqual(original)
  expect(loaded).not.toBe(original)
  expect(() => {
    loaded.world.maps[0].portals[0].destinationSpawnId = 'edited'
  }).toThrow(TypeError)
  expect(() => {
    loaded.progression.expToNextLevel.push(1)
  }).toThrow(TypeError)
  expect(() => {
    loaded.items[5].modifiers.attackPower = 1
  }).toThrow(TypeError)
})

test('normalizes the manifest independently of key and source collection ordering', async () => {
  const source = createInitialGameDataSource()
  const data = loadGameData(source)
  const canonical = serializeMapManifest(data)
  const orderedHash = mapHash(data)
  const reordered = JSON.parse(
    JSON.stringify(source, (_, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).reverse())
      return value
    })
  )
  reordered.world.maps.reverse()
  for (const map of reordered.world.maps) {
    map.portals.reverse()
    map.spawnIds.reverse()
    map.monsterGroups.reverse()
  }

  expect(loadGameData(reordered)).toEqual(data)
  expect(mapHash(loadGameData(reordered))).toBe(orderedHash)
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  expect(Buffer.from(digest).toString('hex')).toBe(orderedHash)
  expect(orderedHash).toMatch(/^[0-9a-f]{64}$/)

  source.world.maps[0].widthTiles += 1
  expect(mapHash(loadGameData(source))).not.toBe(orderedHash)
})

test('rejects mismatched protocol, balance, and map versions in the join contract', () => {
  function version(data) {
    return { protocolVersion: PROTOCOL_VERSION, balanceVersion: data.balanceVersion, mapContentHash: mapHash(data) }
  }

  const source = createInitialGameDataSource()
  const server = version(loadGameData(source))
  expect(checkJoinVersion(server, version(loadGameData(createInitialGameDataSource())))).toEqual({ ok: true })

  expect(checkJoinVersion(server, { ...server, protocolVersion: PROTOCOL_VERSION + 1 })).toEqual({
    ok: false,
    code: 'PROTOCOL_VERSION_MISMATCH',
  })

  source.balanceVersion = 'mvp-2'
  source.items[0].restoreAmount += 1
  const client = version(loadGameData(source))
  expect(client.mapContentHash).toBe(server.mapContentHash)
  expect(checkJoinVersion(server, client)).toEqual({ ok: false, code: 'BALANCE_VERSION_MISMATCH' })

  expect(checkJoinVersion(server, { ...server, mapContentHash: '0'.repeat(64) })).toEqual({
    ok: false,
    code: 'MAP_CONTENT_HASH_MISMATCH',
  })
  expect(checkJoinVersion(server, {})).toEqual({ ok: false, code: 'PROTOCOL_VERSION_MISMATCH' })
})
