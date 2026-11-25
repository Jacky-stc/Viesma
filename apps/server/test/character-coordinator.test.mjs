import { loadGrayboxGameData } from '@viesma/game-data'
import { expect, test, vi } from 'vitest'
import { createCharacterCoordinator, makeCharacterRequest } from '../src/runtime/character-coordinator.ts'
import { createMemoryCharacterRepository } from '../src/runtime/memory-character-repository.ts'

const data = loadGrayboxGameData()
const owner = 'owner'
const unequip = { kind: 'unequip', slot: 'weapon', itemInstanceId: 'starter:owner' }
const operation = (id, version, command = unequip) => makeCharacterRequest('original-connection', id, version, command)

test('initializes once and preserves original receipts while state and version advance', () => {
  const repository = createMemoryCharacterRepository(data.items)
  const apply = vi.fn()
  const coordinator = createCharacterCoordinator(data, apply, repository)
  const initial = coordinator.open(owner)
  const request = operation(1, 0)
  expect(coordinator.execute(owner, request, true)).toBe('CONFIRMED')
  expect(coordinator.open(owner)).toBe(coordinator.read(owner))
  expect(coordinator.read(owner).inventory.equipment.weapon).toBeNull()
  const reward = coordinator.prepareReward([{ characterId: owner, exp: 100 }])
  expect(reward.resultingVersions).toEqual([{ characterId: owner, version: 2 }])
  expect(coordinator.read(owner).version).toBe(1)
  reward.publish()
  expect(coordinator.execute(owner, request, false)).toBe('CONFIRMED')
  expect(coordinator.execute(owner, operation(1, 0, { ...unequip, slot: 'armor' }), true)).toBe('REQUEST_CONFLICT')
  expect(coordinator.execute(owner, operation(2, 0), true)).toBe('STALE_VERSION')
  expect(repository.findReceipt(owner, request.key)).toMatchObject({ version: 1, code: 'CONFIRMED' })
  expect(coordinator.read(owner)).toMatchObject({ version: 2, level: 2, unspentAp: 5 })
  expect(initial.inventory.equipment.weapon.itemInstanceId).toBe('starter:owner')
  expect(apply).toHaveBeenCalledOnce()
  coordinator.release(owner)
  expect(coordinator.read(owner)).toBeUndefined()
})

test('retries after a failure before commit and recovers a lost acknowledgment from the committed receipt', () => {
  const memory = createMemoryCharacterRepository(data.items)
  const apply = vi.fn()
  const repository = {
    ...memory,
    commit: vi
      .fn(memory.commit)
      .mockImplementationOnce(() => {
        throw Error('before commit')
      })
      .mockImplementationOnce((mutation) => {
        memory.commit(mutation)
        throw Error('acknowledgement lost')
      }),
  }
  const coordinator = createCharacterCoordinator(data, apply, repository)
  const before = coordinator.open(owner)
  const request = operation(1, 0)
  expect(() => coordinator.execute(owner, request, true)).toThrow('before commit')
  expect(coordinator.read(owner)).toBe(before)
  expect(repository.findReceipt(owner, request.key)).toBeUndefined()
  expect(apply).not.toHaveBeenCalled()
  expect(coordinator.execute(owner, request, true)).toBe('CONFIRMED')
  expect(coordinator.read(owner)).toMatchObject({ version: 1, inventory: { equipment: { weapon: null } } })
  expect(coordinator.execute(owner, request, true)).toBe('CONFIRMED')
  expect(repository.commit).toHaveBeenCalledTimes(2)
  expect(apply).toHaveBeenCalledExactlyOnceWith(owner, expect.objectContaining({ attackPower: 18 }))
})

test('rejects stale candidates, invalid inventory and equipment IDs already owned by another character', () => {
  const repository = createMemoryCharacterRepository(data.items)
  const coordinator = createCharacterCoordinator(data, vi.fn(), repository)
  const before = coordinator.open(owner)
  const observer = coordinator.open('observer')
  const item = { itemDefinitionId: 'training_sword', itemInstanceId: 'starter:owner', quantity: 1 }
  expect(coordinator.insert('observer', 'dup', item)).toBe('INVALID_ITEM')
  expect(coordinator.read('observer')).toBe(observer)
  const receipt = { key: 'invalid', fingerprint: 'invalid', code: 'CONFIRMED', version: 1, changed: true }
  const next = { ...before, version: 1, inventory: { ...before.inventory, currency: -1 } }
  expect(repository.commit({ characterId: owner, expectedVersion: 0, next, receipt })).toEqual({ kind: 'invalid_inventory' })
  expect(repository.findReceipt(owner, receipt.key)).toBeUndefined()
  expect(coordinator.execute(owner, operation(1, 0), true)).toBe('CONFIRMED')
  expect(repository.commit({ characterId: owner, expectedVersion: 0, next, receipt })).toEqual({ kind: 'stale' })
  expect(coordinator.read(owner).inventory.currency).toBe(0)
})
