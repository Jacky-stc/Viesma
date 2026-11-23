import { parseEquipmentTiers, parseItems, parseLootTables, parseMonsters } from './definitions.js'
import { importTiledMaps } from './tiled/import.js'
import { GAME_DATA_SCHEMA_VERSION, type GameData } from './types.js'
import { array, fields, freeze, id, integer, invalid, maxBasisPoints, maxContentInteger, object, record, uniqueBy } from './validation.js'
import { parseWorld } from './world.js'

const maxSupportedLevel = 1000

/** Fixture 與 runtime validator 共用同一條曲線定義。 */
export function requiredExp(coefficient: number, level: number): bigint {
  return BigInt(coefficient) * BigInt(level) * BigInt(level + 1)
}

function parseProgression(input: unknown): GameData['progression'] {
  const path = 'progression'
  const value = record(input, path, ['levelCap', 'apPerLevel', 'expCoefficient', 'expToNextLevel'])
  const levelCap = integer(value.levelCap, 'progression.levelCap', 2, maxSupportedLevel)
  const apPerLevel = integer(value.apPerLevel, 'progression.apPerLevel', 1)
  const expCoefficient = integer(value.expCoefficient, 'progression.expCoefficient', 1)
  const expToNextLevel = array(
    value.expToNextLevel,
    'progression.expToNextLevel',
    (entry, path) => integer(entry, path, 1),
    levelCap - 1,
    levelCap - 1
  )
  const maxAp = (levelCap - 1) * apPerLevel
  if (maxAp > maxContentInteger) invalid('OVERFLOW', 'progression.apPerLevel', 'AP at level cap exceeds the supported integer range')

  let totalExpToCap = 0
  for (const [index, exp] of expToNextLevel.entries()) {
    const level = index + 1
    const path = `progression.expToNextLevel[${index}]`
    const expected = requiredExp(expCoefficient, level)
    if (expected > BigInt(maxContentInteger))
      invalid('OVERFLOW', path, `Required EXP for level ${level} exceeds the supported integer range`)
    if (BigInt(exp) !== expected) invalid('INVALID_CURVE', path, `Level ${level} requires ${expected} EXP, received ${exp}`)
    totalExpToCap += exp
    if (totalExpToCap > maxContentInteger) invalid('OVERFLOW', path, 'Cumulative EXP exceeds the supported integer range')
  }
  return { levelCap, apPerLevel, expCoefficient, expToNextLevel, totalExpToCap, maxAp }
}

export function loadGameData(input: unknown, tiledExports: unknown = []): GameData {
  const data = object(input, '$')
  if (!Object.hasOwn(data, 'schemaVersion')) invalid('MISSING_FIELD', 'schemaVersion', 'Required field')
  if (data.schemaVersion !== GAME_DATA_SCHEMA_VERSION) {
    invalid('UNSUPPORTED_SCHEMA', 'schemaVersion', `Expected schema version ${GAME_DATA_SCHEMA_VERSION}`)
  }
  fields(data, '$', [
    'schemaVersion',
    'balanceVersion',
    'progression',
    'world',
    'monsterScaling',
    'monsters',
    'items',
    'equipmentTiers',
    'lootTables',
  ])

  const balanceVersion = id(data.balanceVersion, 'balanceVersion')
  const progression = parseProgression(data.progression)
  const { levelCap } = progression
  const scaling = record(data.monsterScaling, 'monsterScaling', ['hpGrowthBpsPerLevel', 'attackPerLevel', 'levelsPerDefensePoint'])
  const monsterScaling = {
    hpGrowthBpsPerLevel: integer(scaling.hpGrowthBpsPerLevel, 'monsterScaling.hpGrowthBpsPerLevel', 0, maxBasisPoints),
    attackPerLevel: integer(scaling.attackPerLevel, 'monsterScaling.attackPerLevel'),
    levelsPerDefensePoint: integer(scaling.levelsPerDefensePoint, 'monsterScaling.levelsPerDefensePoint', 1),
  }
  const items = parseItems(data.items, levelCap)
  const itemsById = uniqueBy(items, (item) => item.id, 'items')
  const equipmentTiers = parseEquipmentTiers(data.equipmentTiers, levelCap, itemsById)
  const lootTables = parseLootTables(data.lootTables, levelCap, itemsById)
  const lootTablesById = uniqueBy(lootTables, (table) => table.id, 'lootTables')
  const monsters = parseMonsters(data.monsters, levelCap, monsterScaling, itemsById, lootTablesById)
  const monstersById = uniqueBy(monsters, (monster) => monster.id, 'monsters')
  const world = parseWorld(data.world, levelCap, monstersById)
  const tiledMaps = importTiledMaps(tiledExports, world, monstersById, levelCap)
  return freeze<GameData>({
    schemaVersion: GAME_DATA_SCHEMA_VERSION,
    balanceVersion,
    progression,
    world,
    tiledMaps,
    monsterScaling,
    monsters,
    items,
    equipmentTiers,
    lootTables,
  })
}
