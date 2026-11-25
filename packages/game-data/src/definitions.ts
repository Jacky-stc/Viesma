import type { ItemDefinitionId } from '@viesma/domain'
import {
  equipmentSlots,
  modifierStats,
  type EquipmentModifiers,
  type EquipmentSlot,
  type EquipmentTier,
  type ItemDefinition,
  type LootEntry,
  type LootTable,
  type LootTableId,
  type MonsterDefinition,
  type MonsterScalingDefinition,
} from './types.js'
import {
  array,
  choice,
  fields,
  id,
  integer,
  invalid,
  maxBasisPoints,
  maxContentInteger,
  name,
  object,
  record,
  reference,
  uniqueBy,
} from './validation.js'

export const stackableItemLimit = 99
const maxStatModifier = 1_000_000

function parseModifiers(input: unknown, path: string): EquipmentModifiers {
  const modifiers = object(input, path)
  fields(modifiers, path, [], modifierStats)
  return Object.fromEntries(
    modifierStats
      .filter((stat) => Object.hasOwn(modifiers, stat))
      .map((stat) => [
        stat,
        integer(modifiers[stat], `${path}.${stat}`, 0, stat === 'criticalChanceBps' ? maxBasisPoints : maxStatModifier),
      ])
  )
}

export function parseItems(input: unknown, levelCap: number): ItemDefinition[] {
  return array(
    input,
    'items',
    (input, path): ItemDefinition => {
      const item = object(input, path)
      const kind = choice(item.kind, `${path}.kind`, ['material', 'consumable', 'equipment'])
      const common = ['kind', 'id', 'name', 'maxStack']
      const specific = {
        material: [],
        consumable: ['resource', 'restoreAmount'],
        equipment: ['slot', 'requiredLevel', 'modifiers'],
      }
      fields(item, path, [...common, ...specific[kind]])
      const base = {
        id: id<ItemDefinitionId>(item.id, `${path}.id`),
        name: name(item.name, `${path}.name`),
        maxStack: integer(item.maxStack, `${path}.maxStack`, 1, kind === 'equipment' ? 1 : stackableItemLimit),
      }

      switch (kind) {
        case 'material':
          return { ...base, kind }
        case 'consumable':
          return {
            ...base,
            kind,
            resource: choice(item.resource, `${path}.resource`, ['hp', 'mp']),
            restoreAmount: integer(item.restoreAmount, `${path}.restoreAmount`, 1),
          }
        case 'equipment':
          return {
            ...base,
            kind,
            slot: choice(item.slot, `${path}.slot`, equipmentSlots),
            requiredLevel: integer(item.requiredLevel, `${path}.requiredLevel`, 1, levelCap),
            modifiers: parseModifiers(item.modifiers, `${path}.modifiers`),
          }
      }
    },
    1
  )
}

export function parseEquipmentTiers(
  input: unknown,
  levelCap: number,
  items: ReadonlyMap<ItemDefinitionId, ItemDefinition>
): EquipmentTier[] {
  const tiers = array(
    input,
    'equipmentTiers',
    (input, path): EquipmentTier => {
      const tier = record(input, path, ['level', 'itemsBySlot'])
      const level = integer(tier.level, `${path}.level`, 1, levelCap)
      const slotsPath = `${path}.itemsBySlot`
      const slots = record(tier.itemsBySlot, slotsPath, equipmentSlots)

      function itemForSlot(slot: EquipmentSlot): ItemDefinitionId {
        const slotPath = `${slotsPath}.${slot}`
        const itemId = id<ItemDefinitionId>(slots[slot], slotPath)
        const item = reference(items, itemId, slotPath)
        if (item.kind !== 'equipment' || item.slot !== slot || item.requiredLevel !== level) {
          invalid('INVALID_REFERENCE', slotPath, `Expected level ${level} ${slot} equipment, received "${itemId}"`)
        }
        return itemId
      }

      return { level, itemsBySlot: { weapon: itemForSlot('weapon'), armor: itemForSlot('armor'), accessory: itemForSlot('accessory') } }
    },
    1,
    levelCap
  )

  let previousLevel = 0
  for (const [index, tier] of tiers.entries()) {
    if ((index === 0 && tier.level !== 1) || tier.level <= previousLevel) {
      invalid('INVALID_VALUE', `equipmentTiers[${index}].level`, 'Tiers must begin at level 1 and increase strictly')
    }
    previousLevel = tier.level
  }
  return tiers
}

function parseLootEntry(input: unknown, path: string, levelCap: number, items: ReadonlyMap<ItemDefinitionId, ItemDefinition>): LootEntry {
  const entry = object(input, path)
  const kind = choice(entry.kind, `${path}.kind`, ['currency', 'item', 'material', 'equipmentTier'])
  const specific = {
    currency: ['minPerLevel', 'maxPerLevel'],
    item: ['itemId', 'minQuantity', 'maxQuantity'],
    material: ['minQuantity', 'maxQuantity'],
    equipmentTier: [],
  }
  fields(entry, path, ['kind', 'id', 'chanceBps', ...specific[kind]])
  const base = {
    id: id<LootEntry['id']>(entry.id, `${path}.id`),
    chanceBps: integer(entry.chanceBps, `${path}.chanceBps`, 0, maxBasisPoints),
  }
  switch (kind) {
    case 'currency': {
      const minPerLevel = integer(entry.minPerLevel, `${path}.minPerLevel`, 1)
      const maxPerLevel = integer(entry.maxPerLevel, `${path}.maxPerLevel`, minPerLevel)
      if (maxPerLevel * levelCap > maxContentInteger) {
        invalid('OVERFLOW', `${path}.maxPerLevel`, 'Currency at level cap exceeds the supported integer range')
      }
      return { ...base, kind, minPerLevel, maxPerLevel }
    }
    case 'equipmentTier':
      return { ...base, kind }
    case 'item': {
      const itemId = id<ItemDefinitionId>(entry.itemId, `${path}.itemId`)
      const item = reference(items, itemId, `${path}.itemId`)
      return { ...base, kind, itemId, ...parseQuantity(entry, path, item.maxStack) }
    }
    case 'material':
      return { ...base, kind, ...parseQuantity(entry, path, stackableItemLimit) }
  }
}

function parseQuantity(input: Record<string, unknown>, path: string, maxStack: number) {
  const minQuantity = integer(input.minQuantity, `${path}.minQuantity`, 1, maxStack)
  const maxQuantity = integer(input.maxQuantity, `${path}.maxQuantity`, minQuantity, maxStack)
  return { minQuantity, maxQuantity }
}

export function parseLootTables(input: unknown, levelCap: number, items: ReadonlyMap<ItemDefinitionId, ItemDefinition>): LootTable[] {
  return array(
    input,
    'lootTables',
    (input, path): LootTable => {
      const table = record(input, path, ['id', 'entries'])
      const entries = array(table.entries, `${path}.entries`, (item, entryPath) => parseLootEntry(item, entryPath, levelCap, items), 1)
      uniqueBy(entries, (entry) => entry.id, `${path}.entries`)
      return { id: id(table.id, `${path}.id`), entries }
    },
    1
  )
}

export function parseMonsters(
  input: unknown,
  levelCap: number,
  scaling: MonsterScalingDefinition,
  items: ReadonlyMap<ItemDefinitionId, ItemDefinition>,
  lootTables: ReadonlyMap<LootTableId, LootTable>
): MonsterDefinition[] {
  return array(
    input,
    'monsters',
    (input, path): MonsterDefinition => {
      const monster = record(input, path, [
        'id',
        'baseHp',
        'baseAttack',
        'baseDefense',
        'baseExp',
        'movement',
        'damageType',
        'patrolSpeed',
        'chaseSpeed',
        'attackReach',
        'materialItemId',
        'lootTableId',
      ])
      const materialItemId = id<ItemDefinitionId>(monster.materialItemId, `${path}.materialItemId`)
      const material = reference(items, materialItemId, `${path}.materialItemId`)
      if (material.kind !== 'material') {
        invalid('INVALID_REFERENCE', `${path}.materialItemId`, `"${materialItemId}" is not a material`)
      }
      const lootTableId = id<LootTableId>(monster.lootTableId, `${path}.lootTableId`)
      const table = reference(lootTables, lootTableId, `${path}.lootTableId`)
      for (const entry of table.entries) {
        if (entry.kind === 'material' && entry.maxQuantity > material.maxStack) {
          invalid(
            'INVALID_REFERENCE',
            `${path}.lootTableId`,
            `Entry "${entry.id}" in "${lootTableId}" exceeds "${materialItemId}" stack limit`
          )
        }
      }

      const definition: MonsterDefinition = {
        id: id(monster.id, `${path}.id`),
        baseHp: integer(monster.baseHp, `${path}.baseHp`, 1),
        baseAttack: integer(monster.baseAttack, `${path}.baseAttack`, 1),
        baseDefense: integer(monster.baseDefense, `${path}.baseDefense`),
        baseExp: integer(monster.baseExp, `${path}.baseExp`, 1),
        movement: choice(monster.movement, `${path}.movement`, ['ground', 'flight']),
        damageType: choice(monster.damageType, `${path}.damageType`, ['physical', 'magic']),
        patrolSpeed: integer(monster.patrolSpeed, `${path}.patrolSpeed`, 1),
        chaseSpeed: integer(monster.chaseSpeed, `${path}.chaseSpeed`, 1),
        attackReach: integer(monster.attackReach, `${path}.attackReach`, 1),
        materialItemId,
        lootTableId,
      }
      validateScaledStats(definition, levelCap, scaling, path)
      return definition
    },
    1
  )
}

/** 使用整數基點，半數向上取整。輸入來自已驗證的內容。 */
export function monsterMaxHpAtLevel(monster: MonsterDefinition, level: number, scaling: MonsterScalingDefinition): bigint {
  const bps = BigInt(maxBasisPoints)
  return (BigInt(monster.baseHp) * (bps + BigInt(level - 1) * BigInt(scaling.hpGrowthBpsPerLevel)) + bps / 2n) / bps
}

export function monsterAttackAtLevel(monster: MonsterDefinition, level: number, scaling: MonsterScalingDefinition): bigint {
  return BigInt(monster.baseAttack) + BigInt(level - 1) * BigInt(scaling.attackPerLevel)
}

export function monsterDefenseAtLevel(monster: MonsterDefinition, level: number, scaling: MonsterScalingDefinition): bigint {
  return BigInt(monster.baseDefense) + BigInt(level - 1) / BigInt(scaling.levelsPerDefensePoint)
}

function validateScaledStats(monster: MonsterDefinition, levelCap: number, scaling: MonsterScalingDefinition, path: string): void {
  // 非負成長在等級上限取得最大值。
  const hp = monsterMaxHpAtLevel(monster, levelCap, scaling)
  const attack = monsterAttackAtLevel(monster, levelCap, scaling)
  const defense = monsterDefenseAtLevel(monster, levelCap, scaling)
  const exp = BigInt(monster.baseExp) * BigInt(levelCap)
  for (const [key, value] of Object.entries({ baseHp: hp, baseAttack: attack, baseDefense: defense, baseExp: exp })) {
    if (value > BigInt(maxContentInteger)) {
      invalid('OVERFLOW', `${path}.${key}`, 'Scaled stat at level cap exceeds the supported integer range')
    }
  }
  if (hp * exp > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid('OVERFLOW', `${path}.baseExp`, 'Scaled HP × EXP exceeds the safe integer range for reward attribution')
  }
}
