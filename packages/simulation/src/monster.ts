import type { CharacterId, DeathId, EncounterId, Monster, MonsterId, SimulationTick, WorldPoint } from '@viesma/domain'
import { initialPlayerAttackBalance, type MonsterArchetypeId, type SpawnId } from '@viesma/game-data'
import type { EncounterLedger } from './encounter-rewards.js'
import type { FacingDirection } from './player.js'
import type { RandomSource } from './random.js'

export interface MonsterSpawnDefinition {
  readonly spawnId: SpawnId
  readonly archetypeId: MonsterArchetypeId
  readonly origin: WorldPoint
  readonly bounds: { readonly min: WorldPoint; readonly max: WorldPoint }
  readonly movement: 'ground' | 'flight'
  readonly maxHp: number
  readonly patrolSpeed: number
  readonly chaseSpeed: number
  readonly attackReach: number
  readonly attack: number
  readonly defense: number
  readonly damageType: 'physical' | 'magic'
}

export interface MonsterTarget {
  readonly characterId: CharacterId
  readonly lifeStartedTick: SimulationTick
}

export type MonsterAggro =
  { readonly target: MonsterTarget; readonly lostAt: null } | { readonly target: null; readonly lostAt: SimulationTick }

export type MonsterAction =
  | { readonly phase: 'windup'; readonly target: MonsterTarget | null }
  | { readonly phase: 'active'; readonly target: MonsterTarget | null }
  | { readonly phase: 'recovery' }

export type MonsterBehavior =
  | { readonly kind: 'spawning' | 'patrol' | 'return' }
  | { readonly kind: 'rewardPending'; readonly deathId: DeathId }
  | { readonly kind: 'dead' | 'respawnWait'; readonly deathId: DeathId; readonly startedAt: SimulationTick }
  | { readonly kind: 'chase'; readonly aggro: MonsterAggro }
  | { readonly kind: 'attack'; readonly aggro: MonsterAggro; readonly startedAt: SimulationTick; readonly action: MonsterAction }

export interface SimulationMonster extends Monster {
  readonly generation: number
  readonly spawn: MonsterSpawnDefinition
  readonly facing: FacingDirection
  readonly hp: number
  readonly behavior: MonsterBehavior
  readonly lastAttackStartedTick: SimulationTick | null
  readonly encounterResetTick: SimulationTick | null
  readonly ledger: EncounterLedger | null
}

export interface MonsterIds {
  nextMonsterId(): MonsterId
  nextEncounterId(): EncounterId
}

export interface MonsterDeathIdentity {
  readonly deathId: DeathId
  readonly monsterId: MonsterId
  readonly generation: number
  readonly encounterId: EncounterId
}

export function spawnMonsters(
  definitions: readonly MonsterSpawnDefinition[],
  maxActive: number,
  ids: MonsterIds,
  rng: RandomSource
): SimulationMonster[] {
  return [...definitions]
    .sort((a, b) => compareIds(a.spawnId, b.spawnId))
    .slice(0, maxActive)
    .map((spawn) => spawnMonster(spawn, ids, rng, 1, null))
    .sort((a, b) => compareIds(a.monsterId, b.monsterId))
}

export function spawnMonster(
  spawn: MonsterSpawnDefinition,
  ids: MonsterIds,
  rng: RandomSource,
  generation: number,
  encounterResetTick: SimulationTick | null
): SimulationMonster {
  return {
    monsterId: ids.nextMonsterId(),
    encounterId: ids.nextEncounterId(),
    generation,
    spawn,
    position: { ...spawn.origin },
    facing: spawnFacing(spawn, rng),
    hp: spawn.maxHp,
    behavior: { kind: 'spawning' },
    lastAttackStartedTick: null,
    encounterResetTick,
    ledger: null,
  }
}

export function monsterCenter({ position }: SimulationMonster): WorldPoint {
  return { x: position.x, y: position.y - initialPlayerAttackBalance.monsterCenterAboveAnchorWorldUnits }
}

export function spawnFacing(spawn: MonsterSpawnDefinition, rng: RandomSource): FacingDirection {
  if (spawn.movement === 'flight') return rng.nextUnit() < 0.5 ? 'left' : 'right'
  return spawn.origin.x < spawn.bounds.max.x ? 'right' : 'left'
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : Number(a > b)
}
