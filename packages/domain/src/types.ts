declare const brand: unique symbol

type Branded<Value, Name extends string> = Value & { readonly [brand]: { readonly [Key in Name]: true } }

export type AccountId = Branded<string, 'AccountId'>
export type CharacterId = Branded<string, 'CharacterId'>
export type MonsterId = Branded<string, 'MonsterId'>
export type EncounterId = Branded<string, 'EncounterId'>
export type MapId = Branded<string, 'MapId'>
export type MapInstanceId = Branded<string, 'MapInstanceId'>
export type AttackId = Branded<string, 'AttackId'>
export type PartyId = Branded<string, 'PartyId'>
export type MembershipToken = Branded<string, 'MembershipToken'>
export type DeathId = Branded<string, 'DeathId'>
export type LootId = Branded<string, 'LootId'>
export type ItemDefinitionId = Branded<string, 'ItemDefinitionId'>
export type ItemInstanceId = Branded<string, 'ItemInstanceId'>
export type SessionEpoch = Branded<string, 'SessionEpoch'>

export type NonNegativeSafeInteger = Branded<number, 'NonNegativeSafeInteger'>
export type SimulationTick = Branded<NonNegativeSafeInteger, 'SimulationTick'>
export type MoveX = -1 | 0 | 1

export interface WorldPoint {
  readonly x: number
  readonly y: number
}

export function isNonNegativeSafeInteger(value: unknown): value is NonNegativeSafeInteger {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function toSimulationTick(value: number): SimulationTick {
  if (!isNonNegativeSafeInteger(value)) {
    throw new RangeError('Simulation tick must be a non-negative safe integer')
  }
  return value as SimulationTick
}
