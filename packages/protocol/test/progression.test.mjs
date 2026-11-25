import { expect, test } from 'vitest'
import { parseOwnerProgression, PROTOCOL_VERSION } from '../src/index.ts'

const snapshot = {
  protocolVersion: PROTOCOL_VERSION,
  characterId: 'character',
  connectionEpoch: 'connection',
  mapEpoch: 2,
  characterVersion: 7,
  level: 2,
  expWithinLevel: 0,
  nextLevelExp: 300,
  unspentAp: 5,
  baseAttributes: { str: 4, dex: 4, int: 4, luk: 4 },
  stats: {
    maxHp: 60,
    maxMp: 35,
    attackPower: 21,
    physicalDefense: 0,
    magicDefense: 1,
    criticalChanceBps: 100,
    criticalMultiplierPercent: 150,
  },
}

test('accepts reward feedback and loot-only feedback at the same character version', () => {
  const grant = { ...snapshot, reward: { sequence: 1, experience: 100, levelsGained: 1, lootCount: 3 } }
  const loot = { ...snapshot, reward: { sequence: 2, experience: 0, levelsGained: 0, lootCount: 1 } }
  expect(parseOwnerProgression(grant)).toEqual(grant)
  expect(parseOwnerProgression(loot)).toEqual(loot)
  expect(parseOwnerProgression(snapshot)).toEqual(snapshot)
})

test('rejects invalid reward summaries and ambiguous command results', () => {
  const reward = { sequence: 1, experience: 100, levelsGained: 1, lootCount: 3 }
  for (const fields of [{ sequence: 0 }, { experience: -1 }, { levelsGained: 2 }, { levelsGained: 0, experience: 0, lootCount: 0 }]) {
    expect(parseOwnerProgression({ ...snapshot, reward: { ...reward, ...fields } })).toBeUndefined()
  }
  expect(parseOwnerProgression({ ...snapshot, reward, result: { requestId: 1, code: 'CONFIRMED' } })).toBeUndefined()
})
