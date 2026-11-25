import type { AttackId, CharacterId, EncounterId, MapInstanceId, MonsterId, SimulationTick } from '@viesma/domain'
import {
  initialPlayerAttackBalance as basicAttack,
  initialMonsterAiBalance,
  maxBasisPoints,
  type PlayerCombatStats,
} from '@viesma/game-data'
import type { SolidObstructionTest } from '@viesma/physics'
import { applyEncounterHit, type EncounterHitContext, type MonsterDeathClaimedEvent } from './encounter-rewards.js'
import { monsterCanReach } from './monster-ai.js'
import { monsterCenter, type SimulationMonster } from './monster.js'
import type { PlayerInputCommand } from './movement-input.js'
import { applyPlayerVitalEffects, enterPlayerDeath, playerHurtAction, type PlayerLifecycleEvent } from './player-lifecycle.js'
import { playerCenter, playerFeet, type SimulationPlayer } from './player.js'
import type { RandomSource } from './random.js'

export interface CombatStepContext extends Pick<EncounterHitContext, 'participant' | 'balanceVersion'> {
  readonly playerStats: PlayerCombatStats
  readonly isObstructed: SolidObstructionTest
  readonly admitAttacks?: boolean
}

interface DamageEventFields {
  readonly tick: SimulationTick
  readonly characterId: CharacterId
  readonly monsterId: MonsterId
  readonly encounterId: EncounterId
  readonly damage: number
  readonly effectiveDamage: number
}

export type MonsterDamageEvent = DamageEventFields & {
  readonly kind: 'monsterDamaged'
  readonly mapInstanceId: MapInstanceId
  readonly attackId: AttackId
  readonly critical: boolean
  readonly lethal: boolean
}

export type CombatDamageEvent =
  MonsterDamageEvent | (DamageEventFields & { readonly kind: 'playerDamaged'; readonly attackStartedTick: SimulationTick })

type CombatEvent = CombatDamageEvent | PlayerLifecycleEvent | MonsterDeathClaimedEvent

export function canStartBasicAttack(
  player: SimulationPlayer,
  input: PlayerInputCommand | undefined,
  tick: SimulationTick
): input is PlayerInputCommand {
  const { lastAttackStartedTick, action, movement } = player
  return (
    input?.attackPressed === true &&
    (movement.lastProcessedInputSeq === null || input.seq > movement.lastProcessedInputSeq) &&
    action.kind !== 'attack' &&
    (lastAttackStartedTick === null || tick - lastAttackStartedTick >= basicAttack.cooldownTicks)
  )
}

export function basicAttackEnded(player: SimulationPlayer, tick: SimulationTick): boolean {
  const swing = player.action.kind === 'attack' ? player.action.swing : undefined
  return swing !== undefined && tick - swing.acceptedTick >= basicAttack.windupTicks + basicAttack.activeTicks + basicAttack.recoveryTicks
}

function resolvePlayerHits(
  monsters: SimulationMonster[],
  encounter: EncounterHitContext,
  context: CombatStepContext,
  rng: RandomSource,
  events: CombatEvent[]
): void {
  const { players, tick, mapInstanceId } = encounter
  const swings = players.flatMap((player) => {
    const { action, vitals } = player
    if (vitals.hp <= 0 || action.kind !== 'attack' || !action.swing || tick - action.swing.acceptedTick !== basicAttack.windupTicks)
      return []
    return [{ player, swing: action.swing, facing: action.facing }]
  })
  swings.sort(
    (a, b) =>
      a.swing.acceptedTick - b.swing.acceptedTick ||
      (a.player.characterId < b.player.characterId ? -1 : Number(a.player.characterId > b.player.characterId)) ||
      a.swing.inputSeq - b.swing.inputSeq
  )

  const resolved = new Set<AttackId>()
  const { attackPower, criticalChanceBps } = context.playerStats
  for (const { player, swing, facing } of swings) {
    if (resolved.has(swing.attackId)) continue
    resolved.add(swing.attackId)

    const center = playerCenter(player)
    let hitCount = 0
    for (const [index, monster] of monsters.entries()) {
      if (
        monster.hp <= 0 ||
        monster.behavior.kind === 'return' ||
        monster.behavior.kind === 'spawning' ||
        monster.ledger?.attackIds.has(swing.attackId) ||
        (monster.encounterResetTick !== null && swing.acceptedTick <= monster.encounterResetTick)
      )
        continue
      const target = monsterCenter(monster)
      const forward = (target.x - center.x) * (facing === 'right' ? 1 : -1)
      if (forward < 0 || forward > basicAttack.reachWorldUnits || Math.abs(target.y - center.y) > basicAttack.heightWorldUnits / 2) continue
      if (context.isObstructed(center, target)) continue

      const rawDamage = Math.max(1, attackPower - monster.spawn.defense)
      const critical = Math.floor(rng.nextUnit() * maxBasisPoints) < criticalChanceBps
      const damage = critical ? Math.floor((rawDamage * basicAttack.criticalMultiplierPercent) / 100) : rawDamage
      const effectiveDamage = Math.min(damage, monster.hp)
      const hit: MonsterDamageEvent = {
        kind: 'monsterDamaged',
        tick,
        mapInstanceId,
        attackId: swing.attackId,
        characterId: player.characterId,
        monsterId: monster.monsterId,
        encounterId: monster.encounterId,
        damage,
        effectiveDamage,
        critical,
        lethal: effectiveDamage === monster.hp,
      }
      const applied = applyEncounterHit(monster, hit, encounter)
      if (!applied) continue
      monsters[index] = applied.monster
      events.push(hit)
      if (applied.intent) events.push({ kind: 'monsterDeathClaimed', intent: applied.intent })
      if (++hitCount === basicAttack.maxTargets) break
    }
  }
}

function resolveMonsterHits(
  players: SimulationPlayer[],
  monsters: readonly SimulationMonster[],
  tick: SimulationTick,
  mapInstanceId: MapInstanceId,
  context: CombatStepContext,
  events: CombatEvent[]
): void {
  for (const monster of monsters) {
    const { behavior, spawn } = monster
    if (
      monster.hp <= 0 ||
      behavior.kind !== 'attack' ||
      behavior.action.phase !== 'active' ||
      behavior.startedAt + initialMonsterAiBalance.windupTicks !== tick
    )
      continue
    const targetRef = behavior.action.target
    if (!targetRef) continue

    const index = players.findIndex(
      ({ characterId, lifeStartedTick }) => characterId === targetRef.characterId && lifeStartedTick === targetRef.lifeStartedTick
    )
    const player = players[index]
    if (!player || player.action.kind === 'death' || player.vitals.hp <= 0 || player.spawnProtected) continue
    if (!monsterCanReach(monster, playerFeet(player)) || context.isObstructed(monsterCenter(monster), playerCenter(player))) continue

    const { characterId } = player
    const { physicalDefense, magicDefense } = context.playerStats
    const damage = Math.max(1, spawn.attack - (spawn.damageType === 'physical' ? physicalDefense : magicDefense))
    const damaged = applyPlayerVitalEffects(player, [{ kind: 'damage', amount: damage }], tick)
    const effectiveDamage = player.vitals.hp - damaged.vitals.hp
    if (effectiveDamage === 0) continue

    events.push({
      kind: 'playerDamaged',
      tick,
      characterId,
      monsterId: monster.monsterId,
      encounterId: monster.encounterId,
      attackStartedTick: behavior.startedAt,
      damage,
      effectiveDamage,
    })
    if (damaged.vitals.hp === 0) {
      const death = enterPlayerDeath(damaged, tick, mapInstanceId, 'damage')
      players[index] = death.player
      events.push(death.event)
    } else {
      players[index] = {
        ...damaged,
        action: playerHurtAction(),
        movement: { ...damaged.movement, jumpBufferTicksRemaining: 0 },
      }
    }
  }
}

export function resolveCombat(
  players: readonly SimulationPlayer[],
  monsters: readonly SimulationMonster[],
  map: Pick<EncounterHitContext, 'tick' | 'mapId' | 'mapInstanceId'>,
  context: CombatStepContext,
  rng: RandomSource,
  events: CombatEvent[]
) {
  if (players.length === 0 || monsters.length === 0) return { players, monsters }
  const nextPlayers = [...players]
  const nextMonsters = [...monsters].sort((a, b) => (a.monsterId < b.monsterId ? -1 : Number(a.monsterId > b.monsterId)))
  const { balanceVersion, participant } = context
  resolvePlayerHits(nextMonsters, { ...map, players, balanceVersion, participant }, context, rng, events)
  resolveMonsterHits(nextPlayers, nextMonsters, map.tick, map.mapInstanceId, context, events)
  return { players: nextPlayers, monsters: nextMonsters }
}
