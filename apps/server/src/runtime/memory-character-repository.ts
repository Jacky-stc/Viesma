import {
  isNonNegativeSafeInteger,
  type CharacterEconomy,
  type CharacterId,
  type CharacterMutation,
  type CharacterMutationReceipt,
  type CharacterMutationResult,
  type InventoryRepository,
  type ItemInstanceId,
} from '@viesma/domain'
import type { ItemDefinition } from '@viesma/game-data'
import { equipmentInstances, isValidInventory } from '@viesma/simulation'

interface Entry {
  state: CharacterEconomy
  readonly receipts: Map<string, CharacterMutationReceipt>
}

function freezeEconomy(state: CharacterEconomy): CharacterEconomy {
  const { inventory } = state
  for (const item of [...inventory.bag, ...Object.values(inventory.equipment)]) {
    if (item) {
      Object.freeze(item.metadata)
      Object.freeze(item)
    }
  }
  Object.freeze(inventory.bag)
  Object.freeze(inventory.equipment)
  Object.freeze(inventory)
  Object.freeze(state.baseAttributes)
  return Object.freeze(state)
}

export function createMemoryCharacterRepository(items: readonly ItemDefinition[]) {
  const entries = new Map<CharacterId, Entry>()
  const owners = new Map<ItemInstanceId, CharacterId>()

  function index(state: CharacterEconomy) {
    for (const { itemInstanceId } of equipmentInstances(state.inventory)) owners.set(itemInstanceId, state.characterId)
  }

  function unindex(state: CharacterEconomy) {
    for (const { itemInstanceId } of equipmentInstances(state.inventory)) owners.delete(itemInstanceId)
  }

  function hasDuplicate(state: CharacterEconomy) {
    const seen = new Set<ItemInstanceId>()
    return equipmentInstances(state.inventory).some(({ itemInstanceId }) => {
      const owner = owners.get(itemInstanceId)
      if (seen.has(itemInstanceId) || (owner !== undefined && owner !== state.characterId)) return true
      seen.add(itemInstanceId)
      return false
    })
  }

  return {
    initialize(characterId: CharacterId, create: () => CharacterEconomy): CharacterEconomy {
      const existing = entries.get(characterId)
      if (existing) return existing.state
      const state = create()
      if (state.characterId !== characterId || state.version !== 0 || !isValidInventory(state.inventory, items) || hasDuplicate(state))
        throw new Error('Invalid initial character state')
      freezeEconomy(state)
      index(state)
      entries.set(characterId, { state, receipts: new Map() })
      return state
    },
    read(characterId: CharacterId) {
      return entries.get(characterId)?.state
    },
    remove(characterId: CharacterId) {
      const state = entries.get(characterId)?.state
      if (state) unindex(state)
      entries.delete(characterId)
    },
    findReceipt(characterId: CharacterId, key: string) {
      return entries.get(characterId)?.receipts.get(key)
    },
    commit({ characterId, expectedVersion, next, receipt }: CharacterMutation): CharacterMutationResult {
      const entry = entries.get(characterId)
      if (!entry) return { kind: 'missing' }
      const previous = entry.receipts.get(receipt.key)
      if (previous) return previous.fingerprint === receipt.fingerprint ? { kind: 'replayed', receipt: previous } : { kind: 'conflict' }
      if (entry.state.version !== expectedVersion) return { kind: 'stale' }
      if (
        next.characterId !== characterId ||
        !isNonNegativeSafeInteger(next.version) ||
        next.version !== receipt.version ||
        receipt.changed !== (next !== entry.state) ||
        (next !== entry.state && (receipt.code !== 'CONFIRMED' || next.version !== expectedVersion + 1))
      )
        return { kind: 'stale' }

      if (
        next !== entry.state &&
        next.inventory !== entry.state.inventory &&
        (!isValidInventory(next.inventory, items) || hasDuplicate(next))
      )
        return { kind: 'invalid_inventory' }
      // 候選狀態與收據準備完成後，同一記憶體執行回合才發布。
      freezeEconomy(next)
      const committed = Object.freeze({ ...receipt })
      if (next.inventory !== entry.state.inventory) {
        unindex(entry.state)
        index(next)
      }
      entry.state = next
      entry.receipts.set(committed.key, committed)
      return { kind: 'committed', receipt: committed }
    },
  } satisfies InventoryRepository & {
    initialize(characterId: CharacterId, create: () => CharacterEconomy): CharacterEconomy
    read(characterId: CharacterId): CharacterEconomy | undefined
    remove(characterId: CharacterId): void
  }
}

export type MemoryCharacterRepository = ReturnType<typeof createMemoryCharacterRepository>
