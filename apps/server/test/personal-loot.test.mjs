import { loadGrayboxGameData } from '@viesma/game-data'
import { allocateSoloExperience, createCharacterAggregate, grantExperience } from '@viesma/simulation'
import { Buffer } from 'node:buffer'
import { createSecretKey } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createServerLootRng } from '../src/runtime/loot-rng.ts'
import { createMemoryPersonalLootRepository } from '../src/runtime/memory-personal-loot.ts'
import { rollSoloPersonalLoot } from '../src/runtime/personal-loot.ts'

const data = loadGrayboxGameData()
const secretBytes = 'm52 fixture key'
const seed = () => createServerLootRng(createSecretKey(Buffer.from(secretBytes, 'utf8')))

function solo(characterId, effectiveDamage = 1, eligible = true) {
  return {
    groupKey: `solo:${characterId}`,
    effectiveDamage,
    contributions: [{ characterId, effectiveDamage, lastDamageTick: 1, lockedGroup: { kind: 'solo' } }],
    eligibleCharacterIds: eligible ? [characterId] : [],
  }
}

function death(groups = [solo('owner')], claimOverrides = {}) {
  return {
    claim: {
      deathId: 'death',
      monsterId: 'monster',
      encounterId: 'encounter',
      generation: 1,
      mapId: 'm1',
      mapInstanceId: 'old-map-instance',
      spawnId: 'spawn_slime_1',
      lethalAttackId: 'swing',
      tick: 1,
      position: { x: 321, y: 123 },
      ...claimOverrides,
    },
    balanceVersion: data.balanceVersion,
    groups,
  }
}

function monsterLevel(level) {
  return {
    ...data,
    tiledMaps: data.tiledMaps.map((map) =>
      map.id === 'm1'
        ? {
            ...map,
            monsterSpawns: map.monsterSpawns.map((spawn) => (spawn.id === 'spawn_slime_1' ? { ...spawn, level } : spawn)),
          }
        : map
    ),
  }
}

function scriptedRng(probabilityDraw = 0, otherDraw = () => 0) {
  return vi.fn(
    (_, ownerId, entryId) => (bound) =>
      bound === 10_000
        ? typeof probabilityDraw === 'function'
          ? probabilityDraw(entryId)
          : probabilityDraw
        : otherDraw(bound, ownerId, entryId)
  )
}

function byEntry(grants) {
  return Object.fromEntries(grants.map(({ tableEntryId, content }) => [tableEntryId, content]))
}

test('derives reproducible streams independently for each death, owner and table entry', () => {
  const rng = seed()
  const vectors = [
    [
      ['death', 'owner', 'equipment'],
      [2014984025, 2904006711, 666648524],
    ],
    [
      ['death', 'owner2', 'equipment'],
      [880506766, 1790912790, 1759449844],
    ],
    [
      ['death', 'owner', 'currency'],
      [3447068022, 643831452, 1199330869],
    ],
    [
      ['death:a', 'b', 'x'],
      [3314363862, 559087485, 2096276617],
    ],
    [
      ['death', 'a:b', 'x'],
      [3027095610, 1191198448, 2308242460],
    ],
  ]
  for (const [key, expected] of vectors) {
    const draw = rng(...key)
    expect(expected.map(() => draw(2 ** 32))).toEqual(expected)
    const replay = seed()(...key)
    expect(expected.map(() => replay(2 ** 32))).toEqual(expected)
  }
  expect(rng('another-death', 'owner', 'equipment')(2 ** 32)).not.toBe(vectors[0][1][0])
})

test('rejects the biased tail before taking an integer remainder', () => {
  const rng = seed()('death', 'owner', 'currency')
  // 第一個字為 3447068022，超過 2^31 + 1 的均分區間。第二個字才可使用。
  expect(rng(2 ** 31 + 1)).toBe(643831452)
  expect(rng(2 ** 32)).toBe(1199330869)
  expect(() => rng(0)).toThrow(RangeError)
  expect(() => rng(1.5)).toThrow(RangeError)
  expect(() => rng(2 ** 32 + 1)).toThrow(RangeError)
})

test('rolls each chance at its inclusive lower and exclusive upper boundary', () => {
  const chances = { hp_potion: 3000, mp_potion: 1500, material: 6000, equipment: 500 }
  const hit = byEntry(
    rollSoloPersonalLoot(
      death(),
      data,
      scriptedRng((entryId) => chances[entryId] - 1)
    )
  )
  expect(hit).toEqual({
    currency: { kind: 'currency', amount: 6 },
    hp_potion: { kind: 'item', itemDefinitionId: 'hp_potion', quantity: 1 },
    mp_potion: { kind: 'item', itemDefinitionId: 'mp_potion', quantity: 1 },
    material: { kind: 'item', itemDefinitionId: 'slime_gel', quantity: 1 },
    equipment: { kind: 'item', itemDefinitionId: 'training_sword', quantity: 1 },
  })
  expect(
    byEntry(
      rollSoloPersonalLoot(
        death(),
        data,
        scriptedRng((entryId) => chances[entryId])
      )
    )
  ).toEqual({
    currency: hit.currency,
  })
  expect(Object.keys(byEntry(rollSoloPersonalLoot(death(), data, scriptedRng(0))))).toHaveLength(5)

  const disabledHp = {
    ...data,
    lootTables: data.lootTables.map((table) => ({
      ...table,
      entries: table.entries.map((entry) => (entry.id === 'hp_potion' ? { ...entry, chanceBps: 0 } : entry)),
    })),
  }
  const disabledRng = scriptedRng(0)
  expect(byEntry(rollSoloPersonalLoot(death(), disabledHp, disabledRng))).not.toHaveProperty('hp_potion')
  expect(disabledRng).not.toHaveBeenCalledWith('death', 'owner', 'hp_potion')
})

test.each([
  [1, 3, 5],
  [5, 15, 25],
  [25, 75, 125],
])('maps every uniform integer outcome at level %i to the inclusive currency interval', (level, lower, upper) => {
  const version = monsterLevel(level)
  const values = Array.from({ length: upper - lower + 1 }, (_, offset) => {
    const random = scriptedRng(9999, (bound) => {
      expect(bound).toBe(upper - lower + 1)
      return offset
    })
    return byEntry(rollSoloPersonalLoot(death(), version, random)).currency.amount
  })
  expect(values).toEqual(Array.from({ length: upper - lower + 1 }, (_, offset) => lower + offset))
})

test.each([
  ['slime', 'slime_gel'],
  ['mushroom', 'spore'],
  ['bat', 'bat_membrane'],
])('uses the %s archetype material with both uniform quantity outcomes', (archetype, material) => {
  const map = data.tiledMaps.find((map) => map.monsterSpawns.some(({ monsterArchetypeId }) => monsterArchetypeId === archetype))
  const spawn = map.monsterSpawns.find(({ monsterArchetypeId }) => monsterArchetypeId === archetype)
  const intent = death(undefined, { mapId: map.id, spawnId: spawn.id })
  for (const offset of [0, 1]) {
    const rng = scriptedRng(0, (bound, _, entry) => {
      if (entry !== 'material') return 0
      expect(bound).toBe(2)
      return offset
    })
    expect(byEntry(rollSoloPersonalLoot(intent, data, rng)).material).toEqual({
      kind: 'item',
      itemDefinitionId: material,
      quantity: offset + 1,
    })
  }
})

test.each([
  [1, 1],
  [4, 1],
  [5, 5],
  [9, 5],
  [10, 10],
  [14, 10],
  [15, 15],
  [19, 15],
  [20, 20],
  [24, 20],
  [25, 25],
])('uses the highest tier for monster level %i and one unbiased draw among its three slots', (level, tier) => {
  const version = monsterLevel(level)
  const expected = [tier === 1 ? 'training_sword' : `sword_tier_${tier}`, `armor_tier_${tier}`, `accessory_tier_${tier}`]
  for (const [index, itemDefinitionId] of expected.entries()) {
    const rng = scriptedRng(0, (bound, _, entryId) => {
      if (entryId !== 'equipment') return 0
      expect(bound).toBe(3)
      return index
    })
    expect(byEntry(rollSoloPersonalLoot(death(), version, rng)).equipment).toEqual({ kind: 'item', itemDefinitionId, quantity: 1 })
  }
})

test('grants nothing at zero damage or without an eligible solo owner', () => {
  const party = { ...solo('party-member'), groupKey: 'party:group' }
  const random = vi.fn()
  for (const groups of [[], [solo('owner', 0)], [solo('owner', 1, false), party]]) {
    expect(rollSoloPersonalLoot(death(groups), data, random)).toEqual([])
  }
  expect(random).not.toHaveBeenCalled()
})

test('rolls a full table for both the eligible zero-EXP recipient and the eligible capped recipient', () => {
  const groups = [solo('zero-exp', 1), solo('cap', 999)]
  expect(allocateSoloExperience(1, groups)).toEqual([{ characterId: 'cap', exp: 1 }])
  const character = grantExperience(createCharacterAggregate('cap'), data.progression.totalExpToCap, data.progression)
  expect(character.level).toBe(25)
  expect(grantExperience(character, 1, data.progression)).toBe(character)

  const rng = scriptedRng()
  const results = rollSoloPersonalLoot(death(groups), data, rng)
  expect(results).toHaveLength(10)
  const [cap, zeroExp] = ['cap', 'zero-exp'].map((owner) => results.filter(({ ownerCharacterId }) => ownerCharacterId === owner))
  expect(byEntry(cap)).toEqual(byEntry(zeroExp))
  expect(rng).toHaveBeenCalledTimes(10)
})

test('keeps grants and their unique IDs stable across recipient order, table order and seeded replay', () => {
  const groups = [solo('b'), solo('a'), solo('c')]
  const intent = death(groups)
  const reorderedData = {
    ...data,
    lootTables: data.lootTables.map((table) => ({ ...table, entries: [...table.entries].reverse() })),
  }
  const first = rollSoloPersonalLoot(intent, data, seed())
  const second = rollSoloPersonalLoot(death([...groups].reverse()), reorderedData, seed())
  expect(first).toEqual(second)
  for (const group of groups) {
    const single = rollSoloPersonalLoot(death([group]), data, seed())
    expect(first.filter(({ ownerCharacterId }) => ownerCharacterId === group.eligibleCharacterIds[0])).toEqual(single)
  }
  const allGrants = [...first, ...rollSoloPersonalLoot(death(groups, { deathId: 'another-death' }), data, seed())]
  expect(new Set(allGrants.map(({ lootId }) => lootId)).size).toBe(allGrants.length)
  expect(
    first.every(({ state, placement, balanceVersion }) => state === 'pending' && placement.kind === 'pending' && balanceVersion === 'mvp-1')
  ).toBe(true)
  expect(first.every((grant) => !Object.hasOwn(grant, 'expiresAtUtcMilliseconds'))).toBe(true)
})

test('keeps pending rolls private on failure and assigns expiry only at successful commit', () => {
  const intent = death()
  const randomForEntry = vi.fn(seed())
  const nowUtcMilliseconds = vi.fn().mockReturnValueOnce(1.5).mockReturnValueOnce(1_795_000_000_100)
  const repository = createMemoryPersonalLootRepository({ nowUtcMilliseconds, randomForEntry })
  expect(() => repository.commitReward(intent, data)).toThrow('Invalid UTC clock')
  expect(repository.findCommittedReward(intent.claim.deathId)).toBeUndefined()
  expect(randomForEntry).toHaveBeenCalledTimes(5)
  expect(() => repository.commitReward(death([solo('conflicting-owner')]), data)).toThrow(
    expect.objectContaining({ code: 'REWARD_IDENTITY_CONFLICT' })
  )

  const receipt = repository.commitReward(intent, data)
  expect(receipt.committedAtUtcMilliseconds).toBe(1_795_000_000_100)
  expect(receipt.grants.length).toBeGreaterThan(0)
  expect(new Set(receipt.grants.map(({ expiresAtUtcMilliseconds }) => expiresAtUtcMilliseconds))).toEqual(new Set([1_795_000_120_100]))
  expect(receipt.grants.every(({ state, placement }) => state === 'committed' && placement.kind === 'pending')).toBe(true)
  expect(repository.commitReward(intent, data)).toBe(receipt)
  expect(repository.findCommittedReward(intent.claim.deathId)).toBe(receipt)
  expect(randomForEntry).toHaveBeenCalledTimes(5)
  expect(nowUtcMilliseconds).toHaveBeenCalledTimes(2)
})

test('recovers the original receipt after lost acknowledgement, clock changes and balance or secret rotation', async () => {
  const intent = death([solo('owner'), solo('second-owner')])
  let rng = seed()
  const randomForEntry = vi.fn((...key) => rng(...key))
  const nowUtcMilliseconds = vi.fn().mockReturnValue(1_795_000_000_000)
  const repository = createMemoryPersonalLootRepository({ nowUtcMilliseconds, randomForEntry })
  async function commitAndLoseAck() {
    repository.commitReward(intent, data)
    throw new Error('acknowledgement lost')
  }
  await expect(commitAndLoseAck()).rejects.toThrow('acknowledgement lost')
  const committed = repository.findCommittedReward(intent.claim.deathId)
  rng = createServerLootRng(createSecretKey(Buffer.alloc(32, 0xa1)))
  nowUtcMilliseconds.mockReturnValue(1_795_000_200_000)
  const updatedData = { ...data, balanceVersion: 'mvp-2', lootTables: [] }
  const retries = await Promise.all([
    Promise.resolve().then(() => repository.commitReward(intent, updatedData)),
    Promise.resolve().then(() => repository.commitReward(death([...intent.groups].reverse()), updatedData)),
  ])
  expect(retries.every((receipt) => receipt === committed)).toBe(true)
  expect(nowUtcMilliseconds).toHaveBeenCalledTimes(1)
  expect(randomForEntry).toHaveBeenCalledTimes(10)
  expect(new Set(committed.grants.map(({ balanceVersion }) => balanceVersion))).toEqual(new Set(['mvp-1']))
  for (const conflict of [
    death(intent.groups, { mapInstanceId: 'new-room' }),
    death([solo('owner'), solo('third-owner')]),
    { ...intent, balanceVersion: 'mvp-2' },
  ]) {
    expect(() => repository.commitReward(conflict, data)).toThrow(expect.objectContaining({ code: 'REWARD_IDENTITY_CONFLICT' }))
  }
})

test('stores immutable server-only content and makes currency a grant', () => {
  const repository = createMemoryPersonalLootRepository({ nowUtcMilliseconds: () => 1_795_000_000_000, randomForEntry: scriptedRng() })
  const intent = death()
  const receipt = repository.commitReward(intent, data)
  const currency = receipt.grants.find(({ tableEntryId }) => tableEntryId === 'currency')
  expect(currency).toEqual({
    state: 'committed',
    lootId: expect.any(String),
    deathId: 'death',
    ownerCharacterId: 'owner',
    tableEntryId: 'currency',
    content: { kind: 'currency', amount: 6 },
    balanceVersion: 'mvp-1',
    mapId: 'm1',
    placement: { kind: 'pending', sourceMapInstanceId: 'old-map-instance', deathPosition: { x: 321, y: 123 } },
    expiresAtUtcMilliseconds: 1_795_000_120_000,
  })
  for (const value of [receipt, receipt.grants, currency, currency.content, currency.placement, currency.placement.deathPosition]) {
    expect(Object.isFrozen(value)).toBe(true)
  }
  expect(() => {
    currency.content.amount = 999
  }).toThrow(TypeError)
  intent.claim.position.x = 0
  intent.groups[0].eligibleCharacterIds.length = 0
  expect(repository.commitReward(death(), data)).toBe(receipt)
  expect(currency.placement.deathPosition.x).toBe(321)
})

test('rejects an unavailable frozen balance version or spawn before a settlement is published', () => {
  const repository = createMemoryPersonalLootRepository()
  expect(() => repository.commitReward({ ...death(), balanceVersion: 'retired' }, data)).toThrow('balance version')
  expect(() => repository.commitReward(death(undefined, { spawnId: 'missing_spawn' }), data)).toThrow('Missing validated monster loot data')
  expect(repository.findCommittedReward('death')).toBeUndefined()
})
