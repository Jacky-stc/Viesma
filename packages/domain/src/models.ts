import type {
  AttackId,
  CharacterId,
  MapId,
  MapInstanceId,
  MembershipToken,
  MonsterId,
  NonNegativeSafeInteger,
  PartyId,
  SimulationTick,
  WorldPoint,
} from './types.js'

export interface Player {
  readonly characterId: CharacterId
  readonly position: WorldPoint
}

export interface Monster {
  readonly monsterId: MonsterId
  readonly position: WorldPoint
  readonly contributions: readonly Contribution[]
}

export interface MapState {
  readonly mapId: MapId
  readonly mapInstanceId: MapInstanceId
  readonly players: readonly Player[]
  readonly monsters: readonly Monster[]
  readonly attacks: readonly Attack[]
}

export interface Attack {
  readonly attackId: AttackId
  readonly acceptedTick: SimulationTick
  readonly source:
    { readonly kind: 'player'; readonly characterId: CharacterId } | { readonly kind: 'monster'; readonly monsterId: MonsterId }
}

export interface Contribution {
  readonly characterId: CharacterId
  readonly effectiveDamage: NonNegativeSafeInteger
  readonly lastDamageTick: SimulationTick
  readonly lockedGroup:
    { readonly kind: 'solo' } | { readonly kind: 'party'; readonly partyId: PartyId; readonly membershipToken: MembershipToken }
}
