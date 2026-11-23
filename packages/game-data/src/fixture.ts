import { stackableItemLimit } from './definitions.js'
import { initialBalanceVersion } from './initial-physics.js'
import { requiredExp } from './load.js'
import { GAME_DATA_SCHEMA_VERSION, type GameDataSource } from './types.js'

const levelCap = 25
const expCoefficient = 50
const standardLootTableId = 'standard_monster'
const hpPotionId = 'hp_potion'
const mpPotionId = 'mp_potion'

type MapSource = GameDataSource['world']['maps'][number]
type MonsterSource = GameDataSource['monsters'][number]
type ItemSource = GameDataSource['items'][number]

const respawn = { mapId: 'village', spawnId: 'spawn_respawn' } as const

const connections = [
  ['village', 'm1'],
  ['village', 'm2'],
  ['village', 'm3'],
  ['village', 'm4'],
  ['m1', 'm5'],
  ['m2', 'm6'],
] as const

function mapDefinition(
  id: string,
  name: string,
  widthTiles: number,
  heightTiles: number,
  recommendedLevels: MapSource['recommendedLevels'],
  groups: readonly (readonly [monsterArchetypeId: string, level: number, count: number])[]
): MapSource {
  const destinations = connections.flatMap(([left, right]) => {
    if (left === id) return [right]
    if (right === id) return [left]
    return []
  })
  return {
    id,
    name,
    widthTiles,
    heightTiles,
    recommendedLevels,
    spawnIds: [...(id === respawn.mapId ? [respawn.spawnId] : []), ...destinations.map((mapId) => `spawn_from_${mapId}`)],
    portals: destinations.map((destinationMapId) => ({
      id: `p_to_${destinationMapId}`,
      destinationMapId,
      destinationSpawnId: `spawn_from_${id}`,
      reversePortalId: `p_to_${id}`,
    })),
    monsterGroups: groups.map(([monsterArchetypeId, level, count]) => ({ monsterArchetypeId, level, count })),
  }
}

const archetype = {
  slime: { id: 'slime', materialItemId: 'slime_gel', materialName: 'Slime Gel' },
  mushroom: { id: 'mushroom', materialItemId: 'spore', materialName: 'Spore' },
  bat: { id: 'bat', materialItemId: 'bat_membrane', materialName: 'Bat Membrane' },
} as const

const { slime, mushroom, bat } = archetype

function maps(): GameDataSource['world']['maps'] {
  return [
    mapDefinition(respawn.mapId, 'Village', 96, 24, null, []),
    mapDefinition('m1', 'Forest Entrance', 128, 32, { min: 1, max: 5 }, [
      [slime.id, 2, 6],
      [mushroom.id, 4, 4],
    ]),
    mapDefinition('m2', 'Eastern Plains', 160, 24, { min: 3, max: 8 }, [
      [slime.id, 4, 4],
      [mushroom.id, 6, 4],
      [bat.id, 7, 2],
    ]),
    mapDefinition('m3', 'Rocky Hills', 128, 48, { min: 6, max: 12 }, [
      [slime.id, 6, 2],
      [mushroom.id, 8, 6],
      [bat.id, 10, 4],
    ]),
    mapDefinition('m4', 'Underground Cave', 128, 40, { min: 10, max: 16 }, [
      [mushroom.id, 11, 4],
      [bat.id, 13, 8],
    ]),
    mapDefinition('m5', 'Deep Forest', 160, 48, { min: 14, max: 20 }, [
      [slime.id, 15, 4],
      [mushroom.id, 17, 4],
      [bat.id, 19, 4],
    ]),
    mapDefinition('m6', 'Ancient Ruins', 160, 40, { min: 18, max: 25 }, [
      [slime.id, 19, 2],
      [mushroom.id, 22, 4],
      [bat.id, 25, 6],
    ]),
  ]
}

function monsters(): readonly MonsterSource[] {
  return [
    {
      id: slime.id,
      baseHp: 60,
      baseAttack: 6,
      baseDefense: 1,
      baseExp: 20,
      movement: 'ground',
      damageType: 'physical',
      patrolSpeed: 60,
      chaseSpeed: 100,
      attackReach: 36,
      materialItemId: slime.materialItemId,
      lootTableId: standardLootTableId,
    },
    {
      id: mushroom.id,
      baseHp: 90,
      baseAttack: 9,
      baseDefense: 3,
      baseExp: 30,
      movement: 'ground',
      damageType: 'physical',
      patrolSpeed: 50,
      chaseSpeed: 90,
      attackReach: 44,
      materialItemId: mushroom.materialItemId,
      lootTableId: standardLootTableId,
    },
    {
      id: bat.id,
      baseHp: 50,
      baseAttack: 8,
      baseDefense: 1,
      baseExp: 25,
      movement: 'flight',
      damageType: 'magic',
      patrolSpeed: 90,
      chaseSpeed: 130,
      attackReach: 40,
      materialItemId: bat.materialItemId,
      lootTableId: standardLootTableId,
    },
  ]
}

const equipmentTierLevels = [1, 5, 10, 15, 20, 25] as const

function equipmentFixture() {
  const items: ItemSource[] = []
  const equipmentTiers = equipmentTierLevels.map((level, index) => {
    const itemsBySlot = {
      weapon: level === 1 ? 'training_sword' : `sword_tier_${level}`,
      armor: `armor_tier_${level}`,
      accessory: `accessory_tier_${level}`,
    }
    const base = { kind: 'equipment', requiredLevel: level, maxStack: 1 } as const
    items.push(
      {
        ...base,
        id: itemsBySlot.weapon,
        name: level === 1 ? 'Training Sword' : `Sword (Lv${level})`,
        slot: 'weapon',
        modifiers: { attackPower: 3 + 2 * index },
      },
      { ...base, id: itemsBySlot.armor, name: `Armor (Lv${level})`, slot: 'armor', modifiers: { physicalDefense: 2 + 2 * index } },
      { ...base, id: itemsBySlot.accessory, name: `Accessory (Lv${level})`, slot: 'accessory', modifiers: { str: 1 + index } }
    )
    return { level, itemsBySlot }
  })
  return { items, equipmentTiers }
}

export function createInitialGameDataSource(): GameDataSource {
  const equipment = equipmentFixture()
  const materials = Object.values(archetype).map(({ materialItemId, materialName }): ItemSource => ({
    id: materialItemId,
    name: materialName,
    kind: 'material',
    maxStack: stackableItemLimit,
  }))
  return {
    schemaVersion: GAME_DATA_SCHEMA_VERSION,
    balanceVersion: initialBalanceVersion,
    progression: {
      levelCap,
      apPerLevel: 5,
      expCoefficient,
      expToNextLevel: Array.from({ length: levelCap - 1 }, (_, index) => Number(requiredExp(expCoefficient, index + 1))),
    },
    world: {
      tileSizeWorldUnits: 32,
      maxMonstersPerMap: 12,
      respawn: { ...respawn },
      maps: maps(),
    },
    monsterScaling: { hpGrowthBpsPerLevel: 1800, attackPerLevel: 2, levelsPerDefensePoint: 2 },
    monsters: monsters(),
    items: [
      { id: hpPotionId, name: 'HP Potion', kind: 'consumable', resource: 'hp', restoreAmount: 50, maxStack: stackableItemLimit },
      { id: mpPotionId, name: 'MP Potion', kind: 'consumable', resource: 'mp', restoreAmount: 30, maxStack: stackableItemLimit },
      ...materials,
      ...equipment.items,
    ],
    equipmentTiers: equipment.equipmentTiers,
    lootTables: [
      {
        id: standardLootTableId,
        entries: [
          { id: 'currency', kind: 'currency', chanceBps: 10000, minPerLevel: 3, maxPerLevel: 5 },
          { id: hpPotionId, kind: 'item', itemId: hpPotionId, chanceBps: 3000, minQuantity: 1, maxQuantity: 1 },
          { id: mpPotionId, kind: 'item', itemId: mpPotionId, chanceBps: 1500, minQuantity: 1, maxQuantity: 1 },
          { id: 'material', kind: 'material', chanceBps: 6000, minQuantity: 1, maxQuantity: 2 },
          { id: 'equipment', kind: 'equipmentTier', chanceBps: 500 },
        ],
      },
    ],
  }
}
