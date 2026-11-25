import type { Attributes, DerivedCombatStats } from '@viesma/domain'
import { initialBalanceVersion } from './initial-physics.js'
import { initialPlayerLifecycleBalance } from './player-lifecycle.js'
import type { EquipmentModifiers, GameData } from './types.js'
import { integer, invalid, maxBasisPoints } from './validation.js'

export { maxBasisPoints }

export const starterWeaponId = 'training_sword'
export const starterInventory = {
  weapon: starterWeaponId,
  bag: [
    { id: 'hp_potion', quantity: 5 },
    { id: 'mp_potion', quantity: 3 },
  ],
} as const
export const initialBaseAttributes: Attributes = Object.freeze({ str: 4, dex: 4, int: 4, luk: 4 })

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

export type PlayerCombatStats = Pick<DerivedCombatStats, 'attackPower' | 'physicalDefense' | 'magicDefense' | 'criticalChanceBps'>

export function getStarterWeaponModifiers({ items }: Pick<GameData, 'items'>): EquipmentModifiers {
  const weapon = items.find(({ id }) => id === starterWeaponId)
  if (!weapon || weapon.kind !== 'equipment' || weapon.slot !== 'weapon' || weapon.requiredLevel !== 1) {
    invalid('INVALID_VALUE', 'items.training_sword', 'Missing level-one starter weapon')
  }
  return weapon.modifiers
}

export function deriveCombatStats(level: number, base: Attributes, modifiers: EquipmentModifiers = {}): DerivedCombatStats {
  const str = base.str + (modifiers.str ?? 0)
  const dex = base.dex + (modifiers.dex ?? 0)
  const int = base.int + (modifiers.int ?? 0)
  const luk = base.luk + (modifiers.luk ?? 0)
  return Object.freeze({
    maxHp: integer(
      initialPlayerLifecycleBalance.beginnerMaxHp + 10 * (level - 1) + 5 * (str - initialBaseAttributes.str) + (modifiers.maxHp ?? 0),
      'character.maxHp',
      1
    ),
    maxMp: integer(
      initialPlayerLifecycleBalance.beginnerMaxMp + 5 * (level - 1) + 3 * (int - initialBaseAttributes.int) + (modifiers.maxMp ?? 0),
      'character.maxMp',
      1
    ),
    attackPower: integer(Math.floor(8 + 2 * str + dex / 2 + (modifiers.attackPower ?? 0)), 'character.attackPower', 1),
    physicalDefense: integer(Math.floor(dex / 4) + (modifiers.physicalDefense ?? 0), 'character.physicalDefense'),
    magicDefense: integer(Math.floor(int / 2) + (modifiers.magicDefense ?? 0), 'character.magicDefense'),
    criticalChanceBps: Math.max(0, Math.min(2500, 500 + 25 * (luk - initialBaseAttributes.luk) + (modifiers.criticalChanceBps ?? 0))),
    criticalMultiplierPercent: initialPlayerAttackBalance.criticalMultiplierPercent,
  })
}

export function getBeginnerCombatStats(data: Pick<GameData, 'items'>): PlayerCombatStats {
  const { attackPower, physicalDefense, magicDefense, criticalChanceBps } = deriveCombatStats(
    1,
    initialBaseAttributes,
    getStarterWeaponModifiers(data)
  )
  return Object.freeze({ attackPower, physicalDefense, magicDefense, criticalChanceBps })
}
