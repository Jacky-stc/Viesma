import type { CharacterCommandCode, CharacterEconomy } from './inventory.js'
import type {
  AccountId,
  CharacterId,
  DeathId,
  ItemDefinitionId,
  LootEntryId,
  LootId,
  MapId,
  MapInstanceId,
  NonNegativeSafeInteger,
  SessionEpoch,
  WorldPoint,
} from './types.js'

export interface Character {
  readonly characterId: CharacterId
  readonly accountId: AccountId
  readonly displayName: string
  readonly version: NonNegativeSafeInteger
}

export interface PlaySession {
  readonly accountId: AccountId
  readonly characterId: CharacterId
  readonly sessionEpoch: SessionEpoch
}

interface GroundLootRoll {
  readonly lootId: LootId
  readonly deathId: DeathId
  readonly ownerCharacterId: CharacterId
  readonly tableEntryId: LootEntryId
  readonly balanceVersion: string
  readonly mapId: MapId
  readonly placement: {
    readonly kind: 'pending'
    readonly sourceMapInstanceId: MapInstanceId
    readonly deathPosition: WorldPoint
  }
  readonly content:
    | { readonly kind: 'currency'; readonly amount: NonNegativeSafeInteger }
    | { readonly kind: 'item'; readonly itemDefinitionId: ItemDefinitionId; readonly quantity: NonNegativeSafeInteger }
}

export type GroundLootGrant = GroundLootRoll &
  ({ readonly state: 'pending' } | { readonly state: 'committed'; readonly expiresAtUtcMilliseconds: NonNegativeSafeInteger })

export interface RewardIntent {
  readonly deathId: DeathId
  readonly balanceVersion: string
  readonly mapId: MapId
  readonly mapInstanceId: MapInstanceId
  readonly recipients: readonly {
    readonly characterId: CharacterId
    readonly exp: NonNegativeSafeInteger
    readonly groundLoot: readonly Extract<GroundLootGrant, { readonly state: 'pending' }>[]
  }[]
}

export interface RewardReceipt {
  readonly deathId: DeathId
  readonly resultingVersions: readonly { readonly characterId: CharacterId; readonly version: NonNegativeSafeInteger }[]
}

export interface CharacterRepository {
  findCharacter(characterId: CharacterId): Promise<Character | undefined>
}

export interface CharacterMutationReceipt {
  readonly key: string
  readonly fingerprint: string
  readonly code: CharacterCommandCode
  readonly changed: boolean
  readonly version: NonNegativeSafeInteger
}

export interface CharacterMutation {
  readonly characterId: CharacterId
  readonly expectedVersion: NonNegativeSafeInteger
  readonly next: CharacterEconomy
  readonly receipt: CharacterMutationReceipt
}

export type CharacterMutationResult =
  | { readonly kind: 'committed' | 'replayed'; readonly receipt: CharacterMutationReceipt }
  | { readonly kind: 'conflict' | 'stale' | 'invalid_inventory' | 'missing' }

export interface InventoryRepository {
  // 收據查找必須先於 version check。比較版本、寫角色及寫收據屬同一交易。
  findReceipt(characterId: CharacterId, key: string): CharacterMutationReceipt | undefined | Promise<CharacterMutationReceipt | undefined>
  commit(mutation: CharacterMutation): CharacterMutationResult | Promise<CharacterMutationResult>
}

export interface SessionRepository {
  findActivePlaySession(accountId: AccountId): Promise<PlaySession | undefined>
}

export interface RewardRepository {
  findCommittedReward(deathId: DeathId): Promise<RewardReceipt | undefined>

  // 實作須原子提交進度與地面獎勵，重試同一 deathId 時回傳既有 receipt。
  commitReward(intent: RewardIntent): Promise<RewardReceipt>
}
