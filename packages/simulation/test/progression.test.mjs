import { attributeNames } from '@viesma/domain'
import { deriveCombatStats, getStarterWeaponModifiers, loadGrayboxGameData } from '@viesma/game-data'
import { expect, test } from 'vitest'
import {
  allocateAttributes,
  allocateSoloExperience,
  clampPlayerVitals,
  createCharacterAggregate,
  createPlayer,
  grantExperience,
} from '../src/index.ts'

const data = loadGrayboxGameData()
const { progression } = data
const initial = createCharacterAggregate('beginner')
const exp = (character, amount) => grantExperience(character, amount, progression)
const amounts = (str = 0, dex = 0, int = 0, luk = 0) => ({ str, dex, int, luk })

function assertInvariant({ level, baseAttributes, unspentAp }) {
  for (const name of attributeNames) expect(baseAttributes[name]).toBeGreaterThanOrEqual(4)
  const spent = attributeNames.reduce((sum, name) => sum + baseAttributes[name] - 4, 0)
  expect(spent + unspentAp).toBe(5 * (level - 1))
}

test('initial state and every level threshold preserve the AP invariant', () => {
  expect(initial).toEqual({
    characterId: 'beginner',
    version: 0,
    level: 1,
    expWithinLevel: 0,
    unspentAp: 0,
    baseAttributes: amounts(4, 4, 4, 4),
  })
  assertInvariant(initial)
  let current = initial
  let total = 0
  for (let level = 1; level < 25; level++) {
    const threshold = progression.expToNextLevel[level - 1]
    expect(threshold).toBe(50 * level * (level + 1))
    const before = exp(current, threshold - 1)
    expect(before).toMatchObject({ level, expWithinLevel: threshold - 1 })
    current = exp(before, 1)
    expect(current).toMatchObject({ level: level + 1, expWithinLevel: 0, unspentAp: 5 * level })
    assertInvariant(current)
    total += threshold
  }
  expect(total).toBe(260000)
  expect(current.unspentAp).toBe(120)
})

test('crosses several thresholds in one grant and discards even safe-integer overflow at cap', () => {
  expect(exp(exp(initial, 99), 905)).toMatchObject({ level: 4, expWithinLevel: 4, unspentAp: 15, version: 2 })
  expect(exp(initial, 259999)).toMatchObject({ level: 24, expWithinLevel: 29999, unspentAp: 115 })
  for (const amount of [260000, 260001, Number.MAX_SAFE_INTEGER]) {
    const capped = exp(exp(initial, 99), amount)
    expect(capped).toMatchObject({ level: 25, expWithinLevel: 0, unspentAp: 120, version: 2 })
    expect(exp(capped, amount)).toBe(capped)
    assertInvariant(capped)
  }
  expect(exp(initial, 0)).toBe(initial)
})

test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid EXP and AP values %s', (value) => {
  expect(() => exp(initial, value)).toThrow(RangeError)
  expect(allocateAttributes(exp(initial, 100), amounts(2, 0, 0, value))).toEqual({ code: 'INVALID_ALLOCATION' })
})

test('rejects the whole allocation on overspend and spends all four attributes atomically', () => {
  const raised = exp(initial, 400)
  expect(allocateAttributes(raised, amounts(5, 3, 2, 1))).toEqual({ code: 'INSUFFICIENT_AP' })
  expect(allocateAttributes(raised, amounts(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))).toEqual({ code: 'INSUFFICIENT_AP' })
  expect(raised.baseAttributes).toEqual(amounts(4, 4, 4, 4))
  expect(allocateAttributes(raised, amounts()).character).toBe(raised)
  const { character } = allocateAttributes(raised, amounts(4, 3, 2, 1))
  expect(character).toMatchObject({ baseAttributes: amounts(8, 7, 6, 5), unspentAp: 0, version: 2 })
  assertInvariant(character)
  assertInvariant(exp(character, 600))
  const max = allocateAttributes(exp(initial, 260000), amounts(120)).character
  expect(max.baseAttributes.str).toBe(124)
  assertInvariant(max)
})

test('applies equipment attributes before derived calculations and clamps critical chance at both bounds', () => {
  const base = initial.baseAttributes
  expect(deriveCombatStats(1, base)).toEqual({
    maxHp: 50,
    maxMp: 30,
    attackPower: 18,
    physicalDefense: 1,
    magicDefense: 2,
    criticalChanceBps: 500,
    criticalMultiplierPercent: 150,
  })
  expect(deriveCombatStats(1, base, getStarterWeaponModifiers(data)).attackPower).toBe(21)
  expect(
    deriveCombatStats(3, amounts(5, 7, 5, 6), {
      str: 2,
      dex: 1,
      int: 1,
      luk: 3,
      maxHp: 8,
      maxMp: 7,
      attackPower: 4,
      physicalDefense: 1,
      magicDefense: 2,
      criticalChanceBps: 11,
    })
  ).toEqual({
    maxHp: 93,
    maxMp: 53,
    attackPower: 30,
    physicalDefense: 3,
    magicDefense: 5,
    criticalChanceBps: 636,
    criticalMultiplierPercent: 150,
  })
  expect(deriveCombatStats(1, base, { criticalChanceBps: -501 }).criticalChanceBps).toBe(0)
  expect(deriveCombatStats(25, amounts(4, 4, 4, 124)).criticalChanceBps).toBe(2500)
})

test('raising maxima preserves current HP/MP and death state, while lower maxima clamp', () => {
  const player = createPlayer(initial.characterId, { x: 0, y: 0 }, true)
  const injured = { ...player, vitals: { ...player.vitals, hp: 37, mp: 12 } }
  const levelUp = deriveCombatStats(2, initial.baseAttributes)
  expect(clampPlayerVitals(injured, levelUp).vitals).toEqual({ hp: 37, mp: 12, maxHp: 60, maxMp: 35 })
  const dead = { ...player, action: { kind: 'death', diedAtTick: 8 }, vitals: { ...player.vitals, hp: 0 } }
  expect(clampPlayerVitals(dead, levelUp)).toMatchObject({ action: dead.action, vitals: { hp: 0, maxHp: 60, mp: 30, maxMp: 35 } })
  expect(clampPlayerVitals(injured, { maxHp: 20, maxMp: 10 }).vitals).toEqual({ hp: 20, maxHp: 20, mp: 10, maxMp: 10 })
})

function group(characterId, effectiveDamage, eligible = true) {
  return { groupKey: `solo:${characterId}`, effectiveDamage, eligibleCharacterIds: eligible ? [characterId] : [], contributions: [] }
}

test('distributes one EXP pool by damage, uses stable largest remainder, and discards ineligible shares', () => {
  const groups = [group('b', 30), group('a', 60), group('c', 10, false)]
  const expected = [
    { characterId: 'a', exp: 61 },
    { characterId: 'b', exp: 30 },
  ]
  expect(allocateSoloExperience(101, groups)).toEqual(expected)
  expect(allocateSoloExperience(101, groups.toReversed())).toEqual(expected)
  expect(allocateSoloExperience(1, [group('z', 1), group('a', 1)])).toEqual([{ characterId: 'a', exp: 1 }])
  expect(allocateSoloExperience(1, [group('z', 1), group('a', 1, false)])).toEqual([])
  expect(allocateSoloExperience(50, [group('a', 0)])).toEqual([])
  expect(allocateSoloExperience(10, [group('a', 1), { ...group('b', 1), groupKey: 'party:one' }])).toEqual([{ characterId: 'a', exp: 5 }])
})
