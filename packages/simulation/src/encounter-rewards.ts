import {
  isNonNegativeSafeInteger,
  type AttackId,
  type CharacterId,
  type Contribution,
  type DeathId,
  type MapId,
  type MapInstanceId,
  type NonNegativeSafeInteger,
  type SimulationTick,
  type WorldPoint,
} from '@viesma/domain'
import { initialEncounterRewardBalance as balance, maxBasisPoints, type SpawnId } from '@viesma/game-data'
import type { MonsterDamageEvent } from './combat.js'
import { monsterCenter, type MonsterDeathIdentity, type SimulationMonster } from './monster.js'
import { playerCenter, type SimulationPlayer } from './player.js'

export type PartyMembership = Extract<Contribution['lockedGroup'], { kind: 'party' }>

export interface EncounterParticipant {
  readonly connected: boolean
  readonly membership?: PartyMembership
}

export interface EncounterLedger {
  readonly contributors: ReadonlyMap<CharacterId, Contribution>
  readonly attackIds: ReadonlySet<AttackId>
}

export interface MonsterDeathClaim extends MonsterDeathIdentity {
  readonly mapId: MapId
  readonly mapInstanceId: MapInstanceId
  readonly spawnId: SpawnId
  readonly lethalAttackId: AttackId
  readonly tick: SimulationTick
  readonly position: WorldPoint
}

type GroupKey = `solo:${CharacterId}` | `party:${PartyMembership['partyId']}`

export interface EncounterRewardIntent {
  readonly claim: MonsterDeathClaim
  readonly balanceVersion: string
  readonly groups: readonly {
    readonly groupKey: GroupKey
    readonly effectiveDamage: number
    readonly contributions: readonly Contribution[]
    readonly eligibleCharacterIds: readonly CharacterId[]
  }[]
}

export function getSoloEligibleCharacterId(group: EncounterRewardIntent['groups'][number]): CharacterId | undefined {
  const [characterId] = group.eligibleCharacterIds
  return group.effectiveDamage > 0 && characterId && group.groupKey === `solo:${characterId}` ? characterId : undefined
}

export interface MonsterDeathClaimedEvent {
  readonly kind: 'monsterDeathClaimed'
  readonly intent: EncounterRewardIntent
}

export interface EncounterHitContext {
  readonly mapId: MapId
  readonly mapInstanceId: MapInstanceId
  readonly tick: SimulationTick
  readonly players: readonly SimulationPlayer[]
  readonly participant: (characterId: CharacterId) => EncounterParticipant | undefined
  readonly balanceVersion: string
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : Number(left > right)
}

function groupKey({ characterId, lockedGroup }: Contribution): GroupKey {
  return lockedGroup.kind === 'party' ? `party:${lockedGroup.partyId}` : `solo:${characterId}`
}

function freezeRewardIntent(
  monster: SimulationMonster,
  lethalAttackId: AttackId,
  contributions: ReadonlyMap<CharacterId, Contribution>,
  context: EncounterHitContext
): EncounterRewardIntent {
  const { mapId, mapInstanceId, tick, balanceVersion } = context
  const { monsterId, generation, encounterId, position, spawn } = monster
  const { spawnId, maxHp } = spawn
  const deathId = JSON.stringify([mapInstanceId, spawnId, monsterId, encounterId]) as DeathId
  const claim = Object.freeze({
    deathId,
    mapId,
    mapInstanceId,
    spawnId,
    monsterId,
    generation,
    encounterId,
    lethalAttackId,
    tick,
    position: Object.freeze({ ...position }),
  })
  const center = monsterCenter(monster)
  const minimumDamage = Math.max(1, Math.ceil((maxHp * balance.minimumContributionBps) / maxBasisPoints))
  const players = new Map(context.players.map((player) => [player.characterId, player]))
  const groups = new Map<GroupKey, { effectiveDamage: number; contributions: Contribution[]; eligibleCharacterIds: CharacterId[] }>()
  const orderedContributions = [...contributions.values()].sort((left, right) => compareIds(left.characterId, right.characterId))
  for (const contribution of orderedContributions) {
    const { characterId, effectiveDamage, lastDamageTick, lockedGroup } = contribution
    const key = groupKey(contribution)
    const group = groups.get(key) ?? { effectiveDamage: 0, contributions: [], eligibleCharacterIds: [] }
    groups.set(key, group)
    group.effectiveDamage += effectiveDamage
    group.contributions.push(contribution)

    const player = players.get(characterId)
    if (!player || player.vitals.hp <= 0 || player.action.kind === 'death') continue
    if (effectiveDamage < minimumDamage || tick - lastDamageTick > balance.recentDamageTicks) continue
    const { x, y } = playerCenter(player)
    if ((x - center.x) ** 2 + (y - center.y) ** 2 > balance.eligibilityRadiusWorldUnits ** 2) continue
    const participant = context.participant(characterId)
    if (!participant?.connected) continue
    const { membership } = participant
    if (
      lockedGroup.kind === 'party' &&
      (membership?.partyId !== lockedGroup.partyId || membership.membershipToken !== lockedGroup.membershipToken)
    )
      continue
    group.eligibleCharacterIds.push(characterId)
  }
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => compareIds(left, right))
    .map(([groupKey, group]) =>
      Object.freeze({
        groupKey,
        effectiveDamage: group.effectiveDamage,
        contributions: Object.freeze(group.contributions),
        eligibleCharacterIds: Object.freeze(group.eligibleCharacterIds),
      })
    )
  return Object.freeze({ claim, balanceVersion, groups: Object.freeze(orderedGroups) })
}

export function applyEncounterHit(
  monster: SimulationMonster,
  hit: MonsterDamageEvent,
  context: EncounterHitContext
): { readonly monster: SimulationMonster; readonly intent?: EncounterRewardIntent } | undefined {
  if (
    context.mapInstanceId !== hit.mapInstanceId ||
    context.tick !== hit.tick ||
    monster.monsterId !== hit.monsterId ||
    monster.encounterId !== hit.encounterId ||
    monster.hp <= 0 ||
    monster.behavior.kind === 'return' ||
    monster.behavior.kind === 'spawning' ||
    (monster.encounterResetTick !== null && hit.tick <= monster.encounterResetTick) ||
    monster.ledger?.attackIds.has(hit.attackId) ||
    !hit.attackId ||
    !context.players.some(({ characterId }) => characterId === hit.characterId) ||
    !isNonNegativeSafeInteger(hit.damage) ||
    !isNonNegativeSafeInteger(hit.effectiveDamage) ||
    hit.effectiveDamage === 0 ||
    hit.effectiveDamage > hit.damage ||
    hit.effectiveDamage > monster.hp ||
    (hit.effectiveDamage !== hit.damage && hit.effectiveDamage !== monster.hp) ||
    hit.lethal !== (hit.effectiveDamage === monster.hp)
  )
    return undefined

  const contributors = new Map(monster.ledger?.contributors)
  const prior = contributors.get(hit.characterId)
  const lockedGroup =
    prior?.lockedGroup ?? Object.freeze({ ...(context.participant(hit.characterId)?.membership ?? { kind: 'solo' as const }) })
  const effectiveDamage = ((prior?.effectiveDamage ?? 0) + hit.effectiveDamage) as NonNegativeSafeInteger
  contributors.set(
    hit.characterId,
    Object.freeze({
      characterId: hit.characterId,
      effectiveDamage,
      lastDamageTick: hit.tick,
      lockedGroup,
    })
  )
  const hp = monster.hp - hit.effectiveDamage
  if (hp > 0) {
    const attackIds = new Set(monster.ledger?.attackIds)
    attackIds.add(hit.attackId)
    return { monster: { ...monster, hp, ledger: { contributors, attackIds } } }
  }

  const intent = freezeRewardIntent(monster, hit.attackId, contributors, context)
  return {
    monster: { ...monster, hp, ledger: null, behavior: { kind: 'rewardPending', deathId: intent.claim.deathId } },
    intent,
  }
}
