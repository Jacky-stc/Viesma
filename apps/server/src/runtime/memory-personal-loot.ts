import {
  isNonNegativeSafeInteger,
  type CharacterId,
  type DeathId,
  type GroundLootGrant,
  type MapId,
  type NonNegativeSafeInteger,
  type RewardReceipt,
  type WorldPoint,
} from '@viesma/domain'
import { initialEncounterRewardBalance, type GameData } from '@viesma/game-data'
import { allocateSoloExperience, type EncounterRewardIntent, type MonsterDeathIdentity } from '@viesma/simulation'
import { isDeepStrictEqual } from 'node:util'
import type { createCharacterCoordinator } from './character-coordinator.ts'
import type { GroundLootStore } from './ground-loot.ts'
import { createServerLootRng } from './loot-rng.ts'
import { rollSoloPersonalLoot, soloRewardRecipients, type LootRollRng, type PendingGroundLootGrant } from './personal-loot.ts'

type CommittedGroundLootGrant = Extract<GroundLootGrant, { readonly state: 'committed' }>
type Progression = ReturnType<ReturnType<typeof createCharacterCoordinator>['prepareReward']>

export interface EncounterRewardReceipt extends RewardReceipt, MonsterDeathIdentity {
  readonly balanceVersion: string
  readonly committedAtUtcMilliseconds: NonNegativeSafeInteger
  readonly grants: readonly CommittedGroundLootGrant[]
  readonly position: WorldPoint | undefined
  readonly recipients: Progression['recipients']
}

interface Settlement {
  readonly intent: EncounterRewardIntent
  state:
    | {
        readonly kind: 'pending'
        readonly grants: readonly PendingGroundLootGrant[]
        position?: WorldPoint
        readonly experience: readonly { readonly characterId: CharacterId; readonly exp: number }[]
      }
    | { readonly kind: 'committed'; readonly receipt: EncounterRewardReceipt }
}

class RewardIdentityConflict extends Error {
  readonly code = 'REWARD_IDENTITY_CONFLICT'

  constructor() {
    super('The death identity already belongs to a different reward intent')
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : Number(left > right)
}

function orderedIntent(intent: EncounterRewardIntent): EncounterRewardIntent {
  return {
    ...intent,
    groups: intent.groups
      .map((group) => ({
        ...group,
        eligibleCharacterIds: [...group.eligibleCharacterIds].sort(),
        contributions: [...group.contributions].sort((left, right) => compareIds(left.characterId, right.characterId)),
      }))
      .sort((left, right) => compareIds(left.groupKey, right.groupKey)),
  }
}

export function createMemoryPersonalLootRepository(
  data: GameData,
  characters: Pick<ReturnType<typeof createCharacterCoordinator>, 'prepareReward'>,
  ground: GroundLootStore,
  baseExperience: (mapId: MapId, spawnId: EncounterRewardIntent['claim']['spawnId']) => number,
  {
    randomForEntry = createServerLootRng(),
    nowUtcMilliseconds = Date.now,
    onStage,
  }: {
    readonly randomForEntry?: LootRollRng
    readonly nowUtcMilliseconds?: () => number
    readonly onStage?: (stage: 'progression' | 'ground' | 'receipt') => void
  } = {}
) {
  const settlements = new Map<DeathId, Settlement>()

  return {
    findCommittedReward(deathId: DeathId): EncounterRewardReceipt | undefined {
      const state = settlements.get(deathId)?.state
      return state?.kind === 'committed' ? state.receipt : undefined
    },
    releaseReceipt(deathId: DeathId): void {
      settlements.delete(deathId)
    },
    commitReward(intent: EncounterRewardIntent): EncounterRewardReceipt {
      const { deathId, mapId, mapInstanceId, spawnId, position: deathPosition, monsterId, generation, encounterId } = intent.claim
      const source = orderedIntent(intent)
      let settlement = settlements.get(deathId)
      if (settlement) {
        if (!isDeepStrictEqual(settlement.intent, source)) throw new RewardIdentityConflict()
      } else {
        const grants = rollSoloPersonalLoot(source, data, randomForEntry)
        const allocated = new Map(
          allocateSoloExperience(baseExperience(mapId, spawnId), source.groups).map((grant) => [grant.characterId, grant.exp])
        )
        const experience = soloRewardRecipients(source.groups).map((characterId) => ({
          characterId,
          exp: allocated.get(characterId) ?? 0,
        }))
        settlement = {
          intent: structuredClone(source),
          state: { kind: 'pending', grants, experience },
        }
        settlements.set(deathId, settlement)
      }
      if (settlement.state.kind === 'committed') return settlement.state.receipt

      // 每次重試都從最新角色狀態準備。已凍結的 roll 和落點繼續沿用。
      if (settlement.state.grants.length) settlement.state.position ??= ground.place(mapId, deathPosition)
      const { experience, position } = settlement.state
      const committedAtUtcMilliseconds = nowUtcMilliseconds()
      const expiresAtUtcMilliseconds = committedAtUtcMilliseconds + initialEncounterRewardBalance.groundLootLifetimeMilliseconds
      if (!isNonNegativeSafeInteger(committedAtUtcMilliseconds) || !isNonNegativeSafeInteger(expiresAtUtcMilliseconds)) {
        throw new RangeError('Invalid UTC clock for loot commit')
      }
      const grants = settlement.state.grants.map((grant): CommittedGroundLootGrant =>
        Object.freeze({ ...grant, state: 'committed', expiresAtUtcMilliseconds })
      )
      const progression = characters.prepareReward(experience)
      onStage?.('progression')
      const delivery = position ? ground.prepareDelivery(grants, mapId, mapInstanceId, committedAtUtcMilliseconds, position) : undefined
      onStage?.('ground')
      const receipt = Object.freeze({
        deathId,
        monsterId,
        generation,
        encounterId,
        balanceVersion: source.balanceVersion,
        committedAtUtcMilliseconds,
        grants: Object.freeze(grants),
        position,
        recipients: progression.recipients,
        resultingVersions: progression.resultingVersions,
      })
      const committed = { kind: 'committed' as const, receipt }
      onStage?.('receipt')
      progression.validate()
      delivery?.validate()
      // 首筆寫入之後只更新已備妥的記憶體索引及參照。
      delivery?.publish()
      progression.publish()
      settlement.state = committed
      return receipt
    },
  }
}
