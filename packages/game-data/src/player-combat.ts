import { initialBalanceVersion } from './initial-physics.js'
import type { GameData } from './types.js'
import { integer, invalid, maxBasisPoints } from './validation.js'

export { maxBasisPoints }

export const starterWeaponId = 'training_sword'

export const initialPlayerAttackBalance = Object.freeze({
  balanceVersion: initialBalanceVersion,
  windupTicks: 4,
  activeTicks: 1,
  recoveryTicks: 9,
  cooldownTicks: 18,
  reachWorldUnits: 48,
  heightWorldUnits: 40,
  maxTargets: 3,
  monsterCenterAboveAnchorWorldUnits: 12,
  criticalMultiplierPercent: 150,
})

export interface PlayerCombatStats {
  readonly attackPower: number
  readonly physicalDefense: number
  readonly magicDefense: number
  readonly criticalChanceBps: number
}

export function getBeginnerCombatStats({ items }: Pick<GameData, 'items'>): PlayerCombatStats {
  const weapon = items.find(({ id }) => id === starterWeaponId)
  if (!weapon || weapon.kind !== 'equipment' || weapon.slot !== 'weapon' || weapon.requiredLevel !== 1) {
    invalid('INVALID_VALUE', 'items.training_sword', 'Missing level-one starter weapon')
  }
  const { modifiers } = weapon
  const baseAttribute = 4
  const str = baseAttribute + (modifiers.str ?? 0)
  const dex = baseAttribute + (modifiers.dex ?? 0)
  const int = baseAttribute + (modifiers.int ?? 0)
  const luk = baseAttribute + (modifiers.luk ?? 0)
  return Object.freeze({
    attackPower: integer(Math.floor(8 + 2 * str + dex / 2 + (modifiers.attackPower ?? 0)), 'beginner.attackPower', 1),
    physicalDefense: integer(Math.floor(dex / 4) + (modifiers.physicalDefense ?? 0), 'beginner.physicalDefense'),
    magicDefense: integer(Math.floor(int / 2) + (modifiers.magicDefense ?? 0), 'beginner.magicDefense'),
    criticalChanceBps: Math.min(2500, 500 + 25 * (luk - baseAttribute) + (modifiers.criticalChanceBps ?? 0)),
  })
}
