import {
  isNonNegativeSafeInteger,
  type DeathId,
  type GroundLootGrant,
  type NonNegativeSafeInteger,
  type RewardReceipt,
} from '@viesma/domain'
import { initialEncounterRewardBalance, type GameData } from '@viesma/game-data'
import type { EncounterRewardIntent } from '@viesma/simulation'
import { isDeepStrictEqual } from 'node:util'
import { createServerLootRng } from './loot-rng.ts'
import { rollSoloPersonalLoot, type LootRollRng, type PendingGroundLootGrant } from './personal-loot.ts'

type CommittedGroundLootGrant = Extract<GroundLootGrant, { readonly state: 'committed' }>

interface PersonalLootReceipt extends Pick<RewardReceipt, 'deathId'> {
  readonly committedAtUtcMilliseconds: NonNegativeSafeInteger
  readonly grants: readonly CommittedGroundLootGrant[]
}

interface Settlement {
  readonly intent: EncounterRewardIntent
  state:
    | { readonly kind: 'pending'; readonly grants: readonly PendingGroundLootGrant[] }
    | { readonly kind: 'committed'; readonly receipt: PersonalLootReceipt }
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

export function createMemoryPersonalLootRepository({
  randomForEntry = createServerLootRng(),
  nowUtcMilliseconds = Date.now,
}: { readonly randomForEntry?: LootRollRng; readonly nowUtcMilliseconds?: () => number } = {}) {
  const settlements = new Map<DeathId, Settlement>()

  return {
    findCommittedReward(deathId: DeathId): PersonalLootReceipt | undefined {
      const state = settlements.get(deathId)?.state
      return state?.kind === 'committed' ? state.receipt : undefined
    },
    commitReward(intent: EncounterRewardIntent, data: GameData): PersonalLootReceipt {
      const { deathId } = intent.claim
      const source = orderedIntent(intent)
      let settlement = settlements.get(deathId)
      if (settlement) {
        if (!isDeepStrictEqual(settlement.intent, source)) throw new RewardIdentityConflict()
      } else {
        settlement = {
          intent: structuredClone(source),
          state: { kind: 'pending', grants: rollSoloPersonalLoot(source, data, randomForEntry) },
        }
        settlements.set(deathId, settlement)
      }
      if (settlement.state.kind === 'committed') return settlement.state.receipt

      // 只有同步提交成功的 receipt 可被讀取。時計失敗時保留已凍結的 roll。
      const committedAtUtcMilliseconds = nowUtcMilliseconds()
      const expiresAtUtcMilliseconds = committedAtUtcMilliseconds + initialEncounterRewardBalance.groundLootLifetimeMilliseconds
      if (!isNonNegativeSafeInteger(committedAtUtcMilliseconds) || !isNonNegativeSafeInteger(expiresAtUtcMilliseconds)) {
        throw new RangeError('Invalid UTC clock for loot commit')
      }
      const grants = settlement.state.grants.map((grant): CommittedGroundLootGrant =>
        Object.freeze({ ...grant, state: 'committed', expiresAtUtcMilliseconds })
      )
      const receipt = Object.freeze({ deathId, committedAtUtcMilliseconds, grants: Object.freeze(grants) })
      settlement.state = { kind: 'committed', receipt }
      return receipt
    },
  }
}
