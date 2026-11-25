import { loadGrayboxGameData } from '@viesma/game-data'
import { allocateSoloExperience, createCharacterAggregate, grantExperience } from '@viesma/simulation'
import { Buffer } from 'node:buffer'
import { createSecretKey } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { makeCharacterRequest } from '../src/runtime/character-coordinator.ts'
import { createServerLootRng } from '../src/runtime/loot-rng.ts'
import { rollSoloPersonalLoot } from '../src/runtime/personal-loot.ts'
import { createRewardFixture } from './reward-fixture.mjs'

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
  const { reward: repository, characters } = createRewardFixture(data, { nowUtcMilliseconds, randomForEntry })
  characters.open('owner')
  expect(() => repository.commitReward(intent)).toThrow('Invalid UTC clock')
  expect(repository.findCommittedReward(intent.claim.deathId)).toBeUndefined()
  expect(randomForEntry).toHaveBeenCalledTimes(5)
  expect(() => repository.commitReward(death([solo('conflicting-owner')]))).toThrow(
    expect.objectContaining({ code: 'REWARD_IDENTITY_CONFLICT' })
  )

  const receipt = repository.commitReward(intent)
  expect(receipt.committedAtUtcMilliseconds).toBe(1_795_000_000_100)
  expect(receipt.grants.length).toBeGreaterThan(0)
  expect(new Set(receipt.grants.map(({ expiresAtUtcMilliseconds }) => expiresAtUtcMilliseconds))).toEqual(new Set([1_795_000_120_100]))
  expect(receipt.grants.every(({ state, placement }) => state === 'committed' && placement.kind === 'pending')).toBe(true)
  expect(repository.commitReward(intent)).toBe(receipt)
  expect(repository.findCommittedReward(intent.claim.deathId)).toBe(receipt)
  expect(randomForEntry).toHaveBeenCalledTimes(5)
  expect(nowUtcMilliseconds).toHaveBeenCalledTimes(2)
})

test('recovers the original receipt after lost acknowledgement, clock changes and balance or secret rotation', async () => {
  const intent = death([solo('owner'), solo('second-owner')])
  let rng = seed()
  const randomForEntry = vi.fn((...key) => rng(...key))
  const nowUtcMilliseconds = vi.fn().mockReturnValue(1_795_000_000_000)
  const rewardData = { ...data }
  const { reward: repository, characters } = createRewardFixture(rewardData, { nowUtcMilliseconds, randomForEntry })
  characters.open('owner')
  characters.open('second-owner')
  async function commitAndLoseAck() {
    repository.commitReward(intent)
    throw new Error('acknowledgement lost')
  }
  await expect(commitAndLoseAck()).rejects.toThrow('acknowledgement lost')
  const committed = repository.findCommittedReward(intent.claim.deathId)
  rng = createServerLootRng(createSecretKey(Buffer.alloc(32, 0xa1)))
  nowUtcMilliseconds.mockReturnValue(1_795_000_200_000)
  const updatedData = { ...data, balanceVersion: 'mvp-2', lootTables: [] }
  Object.assign(rewardData, updatedData)
  const retries = await Promise.all([
    Promise.resolve().then(() => repository.commitReward(intent)),
    Promise.resolve().then(() => repository.commitReward(death([...intent.groups].reverse()))),
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
    expect(() => repository.commitReward(conflict)).toThrow(expect.objectContaining({ code: 'REWARD_IDENTITY_CONFLICT' }))
  }
})

test('stores immutable server-only content and makes currency a grant', () => {
  const { reward: repository, characters } = createRewardFixture(data, {
    nowUtcMilliseconds: () => 1_795_000_000_000,
    randomForEntry: scriptedRng(),
  })
  characters.open('owner')
  const intent = death()
  const receipt = repository.commitReward(intent)
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
  expect(repository.commitReward(death())).toBe(receipt)
  expect(currency.placement.deathPosition.x).toBe(321)
})

test('rejects an unavailable frozen balance version or spawn before a settlement is published', () => {
  const { reward: repository } = createRewardFixture(data)
  expect(() => repository.commitReward({ ...death(), balanceVersion: 'retired' })).toThrow('balance version')
  expect(() => repository.commitReward(death(undefined, { spawnId: 'missing_spawn' }))).toThrow('Missing validated monster loot data')
  expect(repository.findCommittedReward('death')).toBeUndefined()
})

test('keeps completed rolls when safe-floor preparation temporarily fails', () => {
  const randomForEntry = scriptedRng()
  const { reward, ground, characters } = createRewardFixture(data, { randomForEntry })
  const initial = characters.open('owner')
  const place = vi.spyOn(ground, 'place').mockImplementationOnce(() => {
    throw Error('placement unavailable')
  })
  const intent = death()
  expect(() => reward.commitReward(intent)).toThrow('placement unavailable')
  expect(reward.findCommittedReward(intent.claim.deathId)).toBeUndefined()
  expect(characters.read('owner')).toBe(initial)
  expect(ground.view('owner', intent.claim.mapInstanceId).revision).toBe(0)
  expect(reward.commitReward(intent).position).toEqual(place.mock.results[1].value)
  expect(randomForEntry).toHaveBeenCalledTimes(5)
})

test.each(['progression', 'ground', 'receipt'])('rolls back the whole death after staging %s', (failAt) => {
  const randomForEntry = scriptedRng()
  let utc = 1_000
  let fail = true
  const { reward, ground, characters } = createRewardFixture(data, {
    randomForEntry,
    nowUtcMilliseconds: () => utc,
    onStage(stage) {
      if (stage === failAt && fail) throw Error('injected before publication')
    },
  })
  const initial = characters.open('owner')
  const second = characters.open('second-owner')
  const untouched = characters.open('observer')
  const intent = death([solo('owner'), solo('second-owner')])
  const { deathId, mapInstanceId } = intent.claim
  expect(() => reward.commitReward(intent)).toThrow('injected before publication')
  expect(characters.read('owner')).toBe(initial)
  expect(characters.read('second-owner')).toBe(second)
  expect(characters.read('observer')).toBe(untouched)
  for (const id of ['owner', 'second-owner', 'observer']) {
    expect(ground.view(id, mapInstanceId)).toMatchObject({ revision: 0, loot: new Map() })
  }
  expect(reward.findCommittedReward(deathId)).toBeUndefined()
  expect(randomForEntry).toHaveBeenCalledTimes(10)
  utc = 6_000
  fail = false
  const receipt = reward.commitReward(intent)
  expect(receipt.committedAtUtcMilliseconds).toBe(utc)
  expect(receipt.grants).toHaveLength(10)
  expect(receipt.grants.every(({ expiresAtUtcMilliseconds }) => expiresAtUtcMilliseconds === 126_000)).toBe(true)
  for (const { characterId, experience, version } of receipt.recipients) {
    expect(experience).toBe(20)
    expect(characters.read(characterId)).toMatchObject({ version, expWithinLevel: experience })
    expect(ground.view(characterId, mapInstanceId).loot.size).toBe(5)
  }
  expect(randomForEntry).toHaveBeenCalledTimes(10)
})

test.each([{ groups: [] }, { groups: [solo('owner', 0)] }, { groups: [solo('owner', 1, false)] }])(
  'settles a death with no eligible solo damage %#',
  ({ groups }) => {
    const randomForEntry = scriptedRng()
    const { reward, ground, characters } = createRewardFixture(data, { randomForEntry })
    const initial = characters.open('owner')
    const intent = death(groups)
    expect(reward.commitReward(intent)).toMatchObject({ grants: [], recipients: [], resultingVersions: [] })
    expect(randomForEntry).not.toHaveBeenCalled()
    expect(characters.read('owner')).toBe(initial)
    expect(ground.view('owner', intent.claim.mapInstanceId).revision).toBe(0)
  }
)

test('keeps zero-EXP and level-cap contributors loot eligible and applies the existing proportional allocation', () => {
  const { reward, characters, ground } = createRewardFixture(data, { baseExperience: () => 1, randomForEntry: scriptedRng() })
  characters.open('cap')
  characters.open('rounding')
  characters.open('winner')
  characters.prepareReward([{ characterId: 'cap', exp: Number.MAX_SAFE_INTEGER }]).publish()
  const cap = characters.read('cap')
  const intent = death([solo('cap', 2), solo('rounding', 1), solo('winner', 3)])
  const receipt = reward.commitReward(intent)
  expect(cap.level).toBe(data.progression.levelCap)
  expect(characters.read('cap')).toBe(cap)
  expect(receipt.recipients).toMatchObject([
    { characterId: 'cap', experience: 0, version: 1 },
    { characterId: 'rounding', experience: 0, version: 0 },
    { characterId: 'winner', experience: 1, version: 1 },
  ])
  expect(receipt.resultingVersions).toEqual([{ characterId: 'winner', version: 1 }])
  for (const id of ['cap', 'rounding', 'winner']) expect(ground.view(id, intent.claim.mapInstanceId).loot.size).toBe(5)

  const cappedWinner = death([solo('cap', 3), solo('winner', 1)], { deathId: 'capped-winner' })
  expect(reward.commitReward(cappedWinner)).toMatchObject({ recipients: [{ experience: 0 }, { experience: 0 }], resultingVersions: [] })
  expect(ground.view('cap', intent.claim.mapInstanceId).loot.size).toBe(10)
})

test('replays a committed receipt after pickup, expiry and newer character commands without restoring loot or economy', () => {
  let utc = 1_000
  const randomForEntry = scriptedRng()
  const { reward, ground, characters } = createRewardFixture(data, { nowUtcMilliseconds: () => utc, randomForEntry })
  characters.open('owner')
  const intent = death()
  const instance = intent.claim.mapInstanceId
  const receipt = reward.commitReward(intent)
  const { lootId, content } = receipt.grants.find(({ tableEntryId }) => tableEntryId === 'currency')
  const request = makeCharacterRequest('epoch', 1, 1, { kind: 'pickup', lootId })
  const { delivery } = ground.inspectPickup(lootId, 'owner', instance, receipt.position, utc)
  expect(characters.execute('owner', request, { pickup: delivery })).toBe('CONFIRMED')
  const updated = characters.read('owner')
  expect(updated).toMatchObject({ version: 2, inventory: { currency: content.amount } })
  expect(reward.commitReward(intent)).toBe(receipt)
  expect(ground.view('owner', instance).loot.has(lootId)).toBe(false)
  const { lootId: expired } = receipt.grants.find(({ tableEntryId }) => tableEntryId === 'equipment')
  utc += 120_000
  ground.expire(() => utc)
  const expiredView = ground.view('owner', instance)
  expect(expiredView.loot.size).toBe(0)
  expect(reward.commitReward(intent)).toBe(receipt)
  expect(ground.view('owner', instance)).toBe(expiredView)
  expect(ground.inspectPickup(lootId, 'owner', instance, receipt.position, utc)).toEqual({ code: 'LOOT_UNAVAILABLE' })
  expect(ground.inspectPickup(expired, 'owner', instance, receipt.position, utc)).toEqual({ code: 'LOOT_EXPIRED' })
  expect(characters.execute('owner', request, false)).toBe('CONFIRMED')
  expect(characters.read('owner')).toBe(updated)
  expect(randomForEntry).toHaveBeenCalledTimes(5)
})

test('settles multiple pending rewards against interleaved AP, equipment, pickup and consumable debits', () => {
  const nowUtc = 1_000
  const randomForEntry = scriptedRng()
  let fail = false
  const { reward, ground, characters, repository } = createRewardFixture(data, {
    baseExperience: () => 100,
    nowUtcMilliseconds: () => nowUtc,
    randomForEntry,
    onStage(stage) {
      if (fail && stage === 'ground') throw Error('transient staging failure')
    },
  })
  const owner = 'owner'
  characters.open(owner)
  const first = reward.commitReward(death())
  const second = death(undefined, { deathId: 'second' })
  const third = death(undefined, { deathId: 'third' })
  fail = true
  expect(() => reward.commitReward(second)).toThrow('transient staging failure')
  expect(() => reward.commitReward(third)).toThrow('transient staging failure')
  expect(characters.read(owner)).toMatchObject({ level: 2, version: 1, expWithinLevel: 0, unspentAp: 5 })
  expect(ground.view(owner, second.claim.mapInstanceId).loot.size).toBe(5)
  const { itemInstanceId } = characters.read(owner).inventory.equipment.weapon
  const { lootId, content } = first.grants.find(({ tableEntryId }) => tableEntryId === 'currency')
  const { delivery } = ground.inspectPickup(lootId, owner, second.claim.mapInstanceId, first.position, nowUtc)
  const operations = [
    [{ kind: 'ap', deltas: { str: 1, dex: 0, int: 0, luk: 0 } }, true],
    [{ kind: 'unequip', itemInstanceId, slot: 'weapon' }, true],
    [{ kind: 'equip', itemInstanceId, slot: 'weapon', bagSlot: 2 }, true],
    [{ kind: 'pickup', lootId }, { pickup: delivery }],
    [
      { kind: 'consume', bagSlot: 0, itemDefinitionId: 'hp_potion' },
      { effect: { kind: 'heal', lifeStartedTick: 1, dueTick: 2, amount: 50 } },
    ],
  ]
  const commands = operations.map(([operation, admission], index) => {
    const request = makeCharacterRequest('epoch', index + 1, index + 1, operation)
    expect(characters.execute(owner, request, admission)).toBe('CONFIRMED')
    expect(characters.read(owner).version).toBe(index + 2)
    return request
  })
  const afterCommands = characters.read(owner)
  expect(afterCommands).toMatchObject({
    version: 6,
    unspentAp: 4,
    baseAttributes: { str: 5 },
    inventory: { currency: content.amount, equipment: { weapon: { itemInstanceId } } },
  })
  expect(afterCommands.inventory.bag[0].quantity).toBe(4)
  fail = false
  const thirdReceipt = reward.commitReward(third)
  const secondReceipt = reward.commitReward(second)
  expect(thirdReceipt.resultingVersions).toEqual([{ characterId: owner, version: 7 }])
  expect(secondReceipt.resultingVersions).toEqual([{ characterId: owner, version: 8 }])
  const final = characters.read(owner)
  expect(final).toMatchObject({ level: 2, version: 8, unspentAp: 4, expWithinLevel: 200 })
  expect(final.inventory).toBe(afterCommands.inventory)
  for (const [index, request] of commands.entries()) {
    expect(characters.execute(owner, request, false)).toBe('CONFIRMED')
    expect(repository.findReceipt(owner, request.key).version).toBe(index + 2)
  }
  expect(characters.read(owner)).toBe(final)
  expect(reward.commitReward(second)).toBe(secondReceipt)
  expect(reward.commitReward(third)).toBe(thirdReceipt)
  expect(randomForEntry).toHaveBeenCalledTimes(15)
})
