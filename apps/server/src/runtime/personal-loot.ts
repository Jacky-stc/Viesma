import type { CharacterId, DeathId, GroundLootGrant, ItemDefinitionId, LootEntryId, LootId, NonNegativeSafeInteger } from '@viesma/domain'
import { equipmentSlots, maxBasisPoints, type EquipmentTier, type GameData, type LootEntry } from '@viesma/game-data'
import { getSoloEligibleCharacterId, type EncounterRewardIntent } from '@viesma/simulation'

export type PendingGroundLootGrant = Extract<GroundLootGrant, { readonly state: 'pending' }>

type NextInt = (maxExclusive: number) => number
export type LootRollRng = (deathId: DeathId, ownerCharacterId: CharacterId, tableEntryId: LootEntryId) => NextInt

function quantityBetween(min: number, max: number, nextInt: NextInt): NonNegativeSafeInteger {
  // 已驗證的掉落範圍，加上 0..(max-min) 不會超出整數上限。
  return (min === max ? min : min + nextInt(max - min + 1)) as NonNegativeSafeInteger
}

function rollContent(
  entry: LootEntry,
  level: number,
  materialItemId: ItemDefinitionId,
  tier: EquipmentTier,
  nextInt: NextInt
): GroundLootGrant['content'] {
  switch (entry.kind) {
    case 'currency':
      return { kind: 'currency', amount: quantityBetween(entry.minPerLevel * level, entry.maxPerLevel * level, nextInt) }
    case 'item':
    case 'material':
      return {
        kind: 'item',
        itemDefinitionId: entry.kind === 'item' ? entry.itemId : materialItemId,
        quantity: quantityBetween(entry.minQuantity, entry.maxQuantity, nextInt),
      }
    case 'equipmentTier': {
      const slot = equipmentSlots[nextInt(equipmentSlots.length)]
      if (!slot) throw new RangeError('Invalid equipment slot roll')
      return { kind: 'item', itemDefinitionId: tier.itemsBySlot[slot], quantity: 1 as NonNegativeSafeInteger }
    }
  }
}

export function soloRewardRecipients(groups: EncounterRewardIntent['groups']): readonly CharacterId[] {
  const owners = new Set<CharacterId>()
  for (const group of groups) {
    const characterId = getSoloEligibleCharacterId(group)
    if (characterId) owners.add(characterId)
  }
  return [...owners].sort()
}

export function rollSoloPersonalLoot(
  { claim, groups, balanceVersion }: EncounterRewardIntent,
  data: GameData,
  randomForEntry: LootRollRng
): readonly PendingGroundLootGrant[] {
  if (data.balanceVersion !== balanceVersion) throw new RangeError('Loot data does not match the death balance version')

  const owners = soloRewardRecipients(groups)
  if (owners.length === 0) return Object.freeze([])

  const { deathId, mapId, mapInstanceId, spawnId, position } = claim
  const map = data.tiledMaps.find(({ id }) => id === mapId)
  const spawn = map?.monsterSpawns.find(({ id }) => id === spawnId)
  const monster = data.monsters.find(({ id }) => id === spawn?.monsterArchetypeId)
  const table = data.lootTables.find(({ id }) => id === monster?.lootTableId)
  if (!spawn || !monster || !table) throw new RangeError('Missing validated monster loot data for the death claim')

  const { level } = spawn
  const tier = [...data.equipmentTiers].reverse().find((tier) => tier.level <= level)
  if (!tier) throw new RangeError('Missing validated equipment tier for the monster level')

  const placement = Object.freeze({
    kind: 'pending' as const,
    sourceMapInstanceId: mapInstanceId,
    deathPosition: Object.freeze({ ...position }),
  })
  const grants: PendingGroundLootGrant[] = []
  const entries = [...table.entries].sort((left, right) => (left.id < right.id ? -1 : Number(left.id > right.id)))
  for (const ownerCharacterId of owners) {
    for (const entry of entries) {
      if (entry.chanceBps === 0) continue
      const nextInt = randomForEntry(deathId, ownerCharacterId, entry.id)
      if (entry.chanceBps < maxBasisPoints && nextInt(maxBasisPoints) >= entry.chanceBps) continue
      grants.push(
        Object.freeze({
          state: 'pending',
          lootId: `loot:${JSON.stringify([deathId, ownerCharacterId, entry.id])}` as LootId,
          deathId,
          ownerCharacterId,
          tableEntryId: entry.id,
          balanceVersion,
          mapId,
          placement,
          content: Object.freeze(rollContent(entry, level, monster.materialItemId, tier, nextInt)),
        })
      )
    }
  }
  return Object.freeze(grants)
}
