import type { ItemDefinitionId, MapId } from '@viesma/domain'
import type { NormalizedMap } from './tiled/types.js'

export const GAME_DATA_SCHEMA_VERSION = 1

declare const contentIdBrand: unique symbol

type ContentId<Kind extends string> = string & { readonly [contentIdBrand]: Kind }

export type MonsterArchetypeId = ContentId<'MonsterArchetype'>
export type PortalId = ContentId<'Portal'>
export type SpawnId = ContentId<'Spawn'>
export type LootTableId = ContentId<'LootTable'>
export type LootEntryId = ContentId<'LootEntry'>

export const equipmentSlots = ['weapon', 'armor', 'accessory'] as const
export type EquipmentSlot = (typeof equipmentSlots)[number]

export const modifierStats = [
  'str',
  'dex',
  'int',
  'luk',
  'maxHp',
  'maxMp',
  'attackPower',
  'physicalDefense',
  'magicDefense',
  'criticalChanceBps',
] as const
export type EquipmentModifiers = Readonly<Partial<Record<(typeof modifierStats)[number], number>>>

export interface PortalDefinition {
  readonly id: PortalId
  readonly destinationMapId: MapId
  readonly destinationSpawnId: SpawnId
  readonly reversePortalId: PortalId
}

export interface MapMonsterGroup {
  readonly monsterArchetypeId: MonsterArchetypeId
  readonly level: number
  readonly count: number
}

export interface MapDefinition {
  readonly id: MapId
  readonly name: string
  readonly widthTiles: number
  readonly heightTiles: number
  readonly recommendedLevels: { readonly min: number; readonly max: number } | null
  readonly spawnIds: readonly SpawnId[]
  readonly portals: readonly PortalDefinition[]
  readonly monsterGroups: readonly MapMonsterGroup[]
}

export interface WorldDefinition {
  readonly tileSizeWorldUnits: number
  readonly maxMonstersPerMap: number
  readonly respawn: { readonly mapId: MapId; readonly spawnId: SpawnId }
  readonly maps: readonly MapDefinition[]
}

export interface ProgressionDefinition {
  readonly levelCap: number
  readonly apPerLevel: number
  readonly expCoefficient: number
  readonly expToNextLevel: readonly number[]
}

export interface MonsterScalingDefinition {
  readonly hpGrowthBpsPerLevel: number
  readonly attackPerLevel: number
  readonly levelsPerDefensePoint: number
}

export interface MonsterDefinition {
  readonly id: MonsterArchetypeId
  readonly baseHp: number
  readonly baseAttack: number
  readonly baseDefense: number
  readonly baseExp: number
  readonly movement: 'ground' | 'flight'
  readonly damageType: 'physical' | 'magic'
  readonly patrolSpeed: number
  readonly chaseSpeed: number
  readonly attackReach: number
  readonly materialItemId: ItemDefinitionId
  readonly lootTableId: LootTableId
}

interface ItemFields {
  readonly id: ItemDefinitionId
  readonly name: string
  readonly maxStack: number
}

export type ItemDefinition = ItemFields &
  (
    | { readonly kind: 'material' }
    | { readonly kind: 'consumable'; readonly resource: 'hp' | 'mp'; readonly restoreAmount: number }
    | {
        readonly kind: 'equipment'
        readonly slot: EquipmentSlot
        readonly requiredLevel: number
        readonly modifiers: EquipmentModifiers
      }
  )

export interface EquipmentTier {
  readonly level: number
  readonly itemsBySlot: Readonly<Record<EquipmentSlot, ItemDefinitionId>>
}

interface LootEntryFields {
  readonly id: LootEntryId
  readonly chanceBps: number
}

interface QuantityRange {
  readonly minQuantity: number
  readonly maxQuantity: number
}

export type LootEntry = LootEntryFields &
  (
    | { readonly kind: 'currency'; readonly minPerLevel: number; readonly maxPerLevel: number }
    | ({ readonly kind: 'item'; readonly itemId: ItemDefinitionId } & QuantityRange)
    | ({ readonly kind: 'material' } & QuantityRange)
    | { readonly kind: 'equipmentTier' }
  )

export interface LootTable {
  readonly id: LootTableId
  readonly entries: readonly LootEntry[]
}

interface GameDataDocument {
  readonly schemaVersion: typeof GAME_DATA_SCHEMA_VERSION
  readonly balanceVersion: string
  readonly progression: ProgressionDefinition
  readonly world: WorldDefinition
  readonly monsterScaling: MonsterScalingDefinition
  readonly monsters: readonly MonsterDefinition[]
  readonly items: readonly ItemDefinition[]
  readonly equipmentTiers: readonly EquipmentTier[]
  readonly lootTables: readonly LootTable[]
}

type SourceIds<T> = T extends ContentId<string> | MapId | ItemDefinitionId
  ? string
  : T extends object
    ? { [Key in keyof T]: SourceIds<T[Key]> }
    : T

export type GameDataSource = SourceIds<GameDataDocument>

export interface GameData extends GameDataDocument {
  readonly progression: ProgressionDefinition & { readonly totalExpToCap: number; readonly maxAp: number }
  readonly tiledMaps: readonly NormalizedMap[]
}
