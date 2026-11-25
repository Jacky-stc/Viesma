export type { LootEntryId } from '@viesma/domain'
export { monsterAttackAtLevel, monsterDefenseAtLevel, monsterMaxHpAtLevel } from './definitions.js'
export { consumableCooldownTicks, initialEncounterRewardBalance } from './encounter-rewards.js'
export { createInitialGameDataSource } from './fixture.js'
export { loadGrayboxGameData } from './graybox.js'
export type { GuideDefinition } from './guide.js'
export { initialPhysicsBalance, loadPlayerMovementBalance, type PlayerMovementBalance } from './initial-physics.js'
export { loadGameData } from './load.js'
export { initialMonsterAiBalance, loadMonsterAiBalance } from './monster-ai.js'
export {
  deriveCombatStats,
  getBeginnerCombatStats,
  getStarterWeaponModifiers,
  initialBaseAttributes,
  initialPlayerAttackBalance,
  maxBasisPoints,
  starterInventory,
  type PlayerCombatStats,
} from './player-combat.js'
export {
  initialPlayerLifecycleBalance,
  loadPlayerLifecycleBalance,
  loadSafeHubFixture,
  playgroundSafeHub,
  type PlayerLifecycleBalance,
  type SafeHubFixture,
} from './player-lifecycle.js'
export { createLootPlacement } from './tiled/loot-placement.js'
export { listTiledTilesetSources } from './tiled/tiles.js'
export type {
  MapCollider,
  MapMonsterSpawn,
  MapPlayerSpawn,
  MapPoint,
  MapPortal,
  NormalizedMap,
  NormalizedTile,
  NormalizedTileLayer,
  NormalizedTileset,
} from './tiled/types.js'
export { GAME_DATA_SCHEMA_VERSION, equipmentSlots } from './types.js'
export type {
  EquipmentModifiers,
  EquipmentSlot,
  EquipmentTier,
  GameData,
  GameDataSource,
  ItemDefinition,
  LootEntry,
  LootTable,
  LootTableId,
  MapDefinition,
  MapMonsterGroup,
  MonsterArchetypeId,
  MonsterDefinition,
  MonsterScalingDefinition,
  PortalDefinition,
  PortalId,
  ProgressionDefinition,
  SpawnId,
  WorldDefinition,
} from './types.js'
export { GameDataValidationError, type GameDataErrorCode } from './validation.js'
export { serializeMapManifest } from './world.js'
