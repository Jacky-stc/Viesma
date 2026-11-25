import {
  attributeNames,
  isNonNegativeSafeInteger,
  type Attributes,
  type CharacterAggregate,
  type CharacterId,
  type NonNegativeSafeInteger,
} from '@viesma/domain'
import { initialBaseAttributes, type ProgressionDefinition } from '@viesma/game-data'
import type { EncounterRewardIntent } from './encounter-rewards.js'

export function createCharacterAggregate(characterId: CharacterId): CharacterAggregate {
  return {
    characterId,
    version: 0 as NonNegativeSafeInteger,
    level: 1,
    expWithinLevel: 0,
    unspentAp: 0,
    baseAttributes: initialBaseAttributes,
  }
}

export function grantExperience(character: CharacterAggregate, amount: number, progression: ProgressionDefinition): CharacterAggregate {
  if (!isNonNegativeSafeInteger(amount)) throw new RangeError('EXP must be a nonnegative safe integer')
  let { level, expWithinLevel, unspentAp } = character
  if (amount === 0 || level === progression.levelCap) return character

  let remaining: number = amount
  for (let threshold = progression.expToNextLevel[level - 1]; threshold !== undefined; threshold = progression.expToNextLevel[level - 1]) {
    const needed = threshold - expWithinLevel
    if (remaining < needed) {
      expWithinLevel += remaining
      break
    }
    remaining -= needed
    level++
    expWithinLevel = 0
    unspentAp += progression.apPerLevel
  }
  return { ...character, level, expWithinLevel, unspentAp, version: (character.version + 1) as NonNegativeSafeInteger }
}

export function allocateAttributes(
  character: CharacterAggregate,
  deltas: Attributes
): { readonly character: CharacterAggregate } | { readonly code: 'INVALID_ALLOCATION' | 'INSUFFICIENT_AP' } {
  const increments = attributeNames.map((name) => deltas[name])
  if (!increments.every(isNonNegativeSafeInteger)) return { code: 'INVALID_ALLOCATION' }
  if (increments.some((value) => value > character.unspentAp)) return { code: 'INSUFFICIENT_AP' }
  const total = increments.reduce((sum, value) => sum + value, 0)
  if (total > character.unspentAp) return { code: 'INSUFFICIENT_AP' }
  if (total === 0) return { character }
  const { str, dex, int, luk } = character.baseAttributes
  return {
    character: {
      ...character,
      version: (character.version + 1) as NonNegativeSafeInteger,
      unspentAp: character.unspentAp - total,
      baseAttributes: { str: str + deltas.str, dex: dex + deltas.dex, int: int + deltas.int, luk: luk + deltas.luk },
    },
  }
}

export function allocateSoloExperience(
  baseExp: number,
  groups: EncounterRewardIntent['groups']
): readonly { readonly characterId: CharacterId; readonly exp: number }[] {
  if (!isNonNegativeSafeInteger(baseExp)) throw new RangeError('Base EXP must be a nonnegative safe integer')
  const totalDamage = groups.reduce((sum, { effectiveDamage }) => sum + BigInt(effectiveDamage), 0n)
  if (totalDamage === 0n) return []

  let remaining: number = baseExp
  const pools = groups
    .filter(({ effectiveDamage }) => effectiveDamage > 0)
    .map((group) => {
      const numerator = BigInt(baseExp) * BigInt(group.effectiveDamage)
      const pool = Number(numerator / totalDamage)
      remaining -= pool
      return { group, pool, remainder: numerator % totalDamage }
    })
  pools.sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1
    return left.group.groupKey < right.group.groupKey ? -1 : Number(left.group.groupKey > right.group.groupKey)
  })
  return pools.flatMap(({ group, pool }, index) => {
    const exp = pool + Number(index < remaining)
    const [characterId] = group.eligibleCharacterIds
    return exp > 0 && characterId && group.groupKey === `solo:${characterId}` ? [{ characterId, exp }] : []
  })
}
