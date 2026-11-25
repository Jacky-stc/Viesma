import {
  attributeNames,
  equipmentSlots,
  isNonNegativeSafeInteger,
  type Attributes,
  type CharacterCommandCode,
  type CharacterEconomy,
  type CharacterId,
  type DeathId,
  type DerivedCombatStats,
  type EquipmentOperation,
  type Inventory,
  type ItemInstanceId,
} from '@viesma/domain'
import { deriveCombatStats, type EquipmentModifiers, type GameData } from '@viesma/game-data'
import {
  allocateAttributes,
  changeEquipment,
  createCharacterAggregate,
  createStarterInventory,
  grantExperience,
  insertInventory,
  parseInventoryGrant,
  type InventoryGrant,
} from '@viesma/simulation'
import { createMemoryCharacterRepository, type MemoryCharacterRepository } from './memory-character-repository.ts'

export type CharacterOperation = { readonly kind: 'ap'; readonly deltas: Attributes } | EquipmentOperation

export interface CharacterRequest {
  readonly key: string
  readonly fingerprint: string
  readonly expectedCharacterVersion: number
  readonly operation: CharacterOperation
}

export function makeCharacterRequest(
  scope: string,
  requestId: number,
  expectedCharacterVersion: number,
  operation: CharacterOperation
): CharacterRequest {
  const payload =
    operation.kind === 'ap'
      ? attributeNames.map((name) => operation.deltas[name])
      : [operation.slot, operation.itemInstanceId, operation.kind === 'equip' ? operation.bagSlot : null]
  return {
    key: JSON.stringify(['request', scope, requestId]),
    fingerprint: JSON.stringify([operation.kind, expectedCharacterVersion, payload]),
    expectedCharacterVersion,
    operation,
  }
}

export function createCharacterCoordinator(
  data: GameData,
  applyStats: (characterId: CharacterId, stats: DerivedCombatStats) => void,
  repository: MemoryCharacterRepository = createMemoryCharacterRepository(data.items)
) {
  const statsByState = new WeakMap<CharacterEconomy, DerivedCombatStats>()
  const leases = new Map<CharacterId, number>()
  const items = new Map(data.items.map((definition) => [definition.id, definition]))

  function derive(state: CharacterEconomy) {
    const modifiers: Partial<Record<keyof EquipmentModifiers, number>> = {}
    for (const slot of equipmentSlots) {
      const item = state.inventory.equipment[slot]
      if (!item) continue
      const definition = items.get(item.itemDefinitionId)
      if (definition?.kind !== 'equipment' || definition.slot !== slot) throw new RangeError('Invalid equipped item definition')
      for (const key of Object.keys(definition.modifiers) as (keyof EquipmentModifiers)[]) {
        modifiers[key] = (modifiers[key] ?? 0) + (definition.modifiers[key] ?? 0)
      }
    }
    return deriveCombatStats(state.level, state.baseAttributes, modifiers)
  }

  function stats(state: CharacterEconomy) {
    let current = statsByState.get(state)
    if (!current) {
      current = derive(state)
      statsByState.set(state, current)
    }
    return current
  }

  function replay(characterId: CharacterId, key: string, fingerprint: string): CharacterCommandCode | undefined {
    const receipt = repository.findReceipt(characterId, key)
    if (receipt) return receipt.fingerprint === fingerprint ? receipt.code : 'REQUEST_CONFLICT'
  }

  function commit(
    current: CharacterEconomy,
    key: string,
    fingerprint: string,
    code: CharacterCommandCode,
    next = current
  ): CharacterCommandCode {
    if (!isNonNegativeSafeInteger(next.version)) return 'STALE_VERSION'
    const nextStats = next !== current ? stats(next) : undefined
    let result
    try {
      result = repository.commit({
        characterId: current.characterId,
        expectedVersion: current.version,
        next,
        receipt: { key, fingerprint, code, changed: next !== current, version: next.version },
      })
    } catch (error) {
      const receipt = repository.findReceipt(current.characterId, key)
      if (!receipt || receipt.fingerprint !== fingerprint) throw error
      if (nextStats && repository.read(current.characterId)?.version === next.version) applyStats(current.characterId, nextStats)
      return receipt.code
    }
    switch (result.kind) {
      case 'committed':
        if (nextStats) applyStats(current.characterId, nextStats)
        return result.receipt.code
      case 'replayed':
        return result.receipt.code
      case 'conflict':
        return 'REQUEST_CONFLICT'
      case 'missing':
        return 'UNAVAILABLE'
      case 'stale':
        return 'STALE_VERSION'
      case 'invalid_inventory':
        return commit(current, key, fingerprint, 'INVALID_ITEM')
    }
  }

  function withInventory(current: CharacterEconomy, inventory: Inventory): CharacterEconomy {
    return { ...current, version: (current.version + 1) as CharacterEconomy['version'], inventory }
  }

  function retain(characterId: CharacterId) {
    leases.set(characterId, (leases.get(characterId) ?? 0) + 1)
  }

  function release(characterId: CharacterId) {
    const remaining = (leases.get(characterId) ?? 0) - 1
    if (remaining > 0) leases.set(characterId, remaining)
    else {
      leases.delete(characterId)
      repository.remove(characterId)
    }
  }

  return {
    open(characterId: CharacterId) {
      const existing = repository.read(characterId)
      if (existing) return existing
      const state = repository.initialize(characterId, () => ({
        ...createCharacterAggregate(characterId),
        inventory: createStarterInventory(data.items, `starter:${characterId}` as ItemInstanceId),
      }))
      retain(characterId)
      return state
    },
    release,
    read: repository.read,
    stats,
    replay,
    execute(characterId: CharacterId, request: CharacterRequest, available: boolean): CharacterCommandCode {
      const { key, fingerprint, expectedCharacterVersion, operation } = request
      const previous = replay(characterId, key, fingerprint)
      if (previous) return previous
      const current = repository.read(characterId)
      if (!current) return 'UNAVAILABLE'
      if (!available) return commit(current, key, fingerprint, 'UNAVAILABLE')
      if (current.version !== expectedCharacterVersion) return commit(current, key, fingerprint, 'STALE_VERSION')
      if (operation.kind === 'ap') {
        const result = allocateAttributes(current, operation.deltas)
        return 'code' in result
          ? commit(current, key, fingerprint, result.code)
          : commit(
              current,
              key,
              fingerprint,
              'CONFIRMED',
              result.character === current ? current : { ...result.character, inventory: current.inventory }
            )
      }
      const result = changeEquipment(current.inventory, operation, current.level, data.items)
      return 'code' in result
        ? commit(current, key, fingerprint, result.code)
        : commit(current, key, fingerprint, 'CONFIRMED', withInventory(current, result.inventory))
    },
    insert(characterId: CharacterId, grantId: string, grant: InventoryGrant): CharacterCommandCode {
      const normalized = parseInventoryGrant(grant)
      const current = repository.read(characterId)
      if (!current) return 'UNAVAILABLE'
      if (!normalized) return 'INVALID_ITEM'
      const key = JSON.stringify(['inventory', grantId])
      const fingerprint = JSON.stringify(normalized)
      const previous = replay(characterId, key, fingerprint)
      if (previous) return previous
      const result = insertInventory(current.inventory, normalized, data.items)
      return 'code' in result
        ? commit(current, key, fingerprint, result.code)
        : commit(current, key, fingerprint, 'CONFIRMED', withInventory(current, result.inventory))
    },
    retainExperience(characterId: CharacterId, deathId: DeathId, exp: number) {
      if (!repository.read(characterId)) return undefined
      retain(characterId)
      const key = JSON.stringify(['exp', deathId])
      const fingerprint = JSON.stringify(exp)
      let settled: { readonly characterId: CharacterId; readonly version: CharacterEconomy['version'] } | null | undefined
      return () => {
        if (settled !== undefined) return settled ?? undefined
        const current = repository.read(characterId)
        if (!current) throw new Error('Missing retained EXP recipient')
        let receipt = repository.findReceipt(characterId, key)
        if (!receipt) {
          const progression = grantExperience(current, exp, data.progression)
          const next = progression === current ? current : { ...progression, inventory: current.inventory }
          if (commit(current, key, fingerprint, 'CONFIRMED', next) !== 'CONFIRMED') throw new Error('Experience grant commit failed')
          receipt = repository.findReceipt(characterId, key)
        }
        if (!receipt || receipt.fingerprint !== fingerprint) throw new Error('Conflicting experience grant')
        settled = receipt.changed ? Object.freeze({ characterId, version: receipt.version }) : null
        release(characterId)
        return settled ?? undefined
      }
    },
  }
}
