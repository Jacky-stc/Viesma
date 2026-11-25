import type { CharacterId, NonNegativeSafeInteger } from './types.js'

export const attributeNames = ['str', 'dex', 'int', 'luk'] as const
export type Attributes = Readonly<Record<(typeof attributeNames)[number], number>>

export interface CharacterAggregate {
  readonly characterId: CharacterId
  readonly version: NonNegativeSafeInteger
  readonly level: number
  readonly expWithinLevel: number
  readonly unspentAp: number
  readonly baseAttributes: Attributes
}

export interface DerivedCombatStats {
  readonly maxHp: number
  readonly maxMp: number
  readonly attackPower: number
  readonly physicalDefense: number
  readonly magicDefense: number
  readonly criticalChanceBps: number
  readonly criticalMultiplierPercent: number
}
