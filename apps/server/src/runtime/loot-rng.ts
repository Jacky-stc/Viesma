import { createHmac, createSecretKey, randomBytes } from 'node:crypto'
import type { LootRollRng } from './personal-loot.ts'

const uint32Range = 2 ** 32
const domain = 'viesma.personal-loot.roll.v1'

export function createServerLootRng(secret = createSecretKey(randomBytes(32))): LootRollRng {
  return (deathId, ownerCharacterId, tableEntryId) => {
    let counter = 0
    return (maxExclusive) => {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > uint32Range) {
        throw new RangeError('Loot RNG requires an integer bound in 1..2^32')
      }
      // 拒絕無法均分的尾端區間，避免以取餘數抽整數造成偏差。
      const limit = uint32Range - (uint32Range % maxExclusive)
      let value: number
      do {
        const message = JSON.stringify([domain, deathId, ownerCharacterId, tableEntryId, counter++])
        value = createHmac('sha256', secret).update(message, 'utf8').digest().readUInt32BE(0)
      } while (value >= limit)
      return value % maxExclusive
    }
  }
}
