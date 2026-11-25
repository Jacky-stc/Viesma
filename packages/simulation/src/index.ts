export { createSolidPointSweep as createMonsterMovement, createSolidObstructionTest } from '@viesma/physics'
export type { CombatDamageEvent, CombatStepContext, MonsterDamageEvent } from './combat.js'
export {
  getSoloEligibleCharacterId,
  type EncounterRewardIntent,
  type MonsterDeathClaim,
  type PartyMembership,
} from './encounter-rewards.js'
export { createFixedTickDriver, fixedDeltaSeconds, maxCatchUpTicks, ticksPerSecond } from './fixed-tick.js'
export type { FixedTick, FixedTickAdvance, FixedTickDriver, MonotonicClock } from './fixed-tick.js'
export {
  changeCurrency,
  changeEquipment,
  createStarterInventory,
  equipmentInstances,
  insertInventory,
  isValidInventory,
  parseInventoryGrant,
  type InventoryGrant,
} from './inventory.js'
export {
  canUseGroundedInteraction,
  createLocalWorld,
  findOverlappingPortal,
  type GuideInteraction,
  type LocalGuideEvent,
  type LocalPortalEvent,
  type LocalWorldState,
} from './local-world.js'
export type { MonsterStepContext } from './monster-ai.js'
export {
  spawnMonsters,
  type MonsterDeathIdentity,
  type MonsterIds,
  type MonsterSpawnDefinition,
  type SimulationMonster,
} from './monster.js'
export {
  normalizeMovementInput,
  type LocalMapInputCommand,
  type MovementButtons,
  type MovementInput,
  type NpcInteractionRequest,
  type PlayerInputCommand,
} from './movement-input.js'
export { createPlayerController, type PlayerController } from './player-controller.js'
export { applyPlayerVitalEffects, respawnPlayer, type PlayerLifecycleEvent, type PlayerVitalEffect } from './player-lifecycle.js'
export {
  clampPlayerVitals,
  createPlayer,
  getPlayerPresentationState,
  neutralMovement,
  placePlayerAtSpawn,
  playerFeet,
  type FacingDirection,
  type PlayerAction,
  type PlayerActionEvent,
  type PlayerControllerState,
  type PlayerLocomotion,
  type PlayerMovementIntent,
  type PlayerPhysicsState,
  type PlayerPresentationState,
  type PlayerVitals,
  type SimulationPlayer,
} from './player.js'
export { allocateAttributes, allocateSoloExperience, createCharacterAggregate, grantExperience } from './progression.js'
export { createSeededRng } from './random.js'
export type { RandomSource } from './random.js'
export { createSafeHubSpawn, type SafeHubSpawn } from './safe-hub.js'
export { step } from './step.js'
export type {
  SimulationCommand,
  SimulationContext,
  SimulationEvent,
  SimulationIdSource,
  SimulationState,
  SimulationStepResult,
} from './step.js'
