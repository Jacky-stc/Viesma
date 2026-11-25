import { createCharacterCoordinator } from '../src/runtime/character-coordinator.ts'
import { createGroundLootStore } from '../src/runtime/ground-loot.ts'
import { createMemoryCharacterRepository } from '../src/runtime/memory-character-repository.ts'
import { createMemoryPersonalLootRepository } from '../src/runtime/memory-personal-loot.ts'
import { getMonsterSpawnDefinitions } from '../src/runtime/monster-spawns.ts'

export function createRewardFixture(data, options = {}) {
  const ground = createGroundLootStore(data.tiledMaps)
  const { nowUtcMilliseconds = Date.now, baseExperience, ...rewardOptions } = options
  const repository = createMemoryCharacterRepository(data.items, { store: ground, nowUtcMilliseconds })
  const characters = createCharacterCoordinator(data, () => {}, repository)
  const spawnExperience =
    baseExperience ??
    ((mapId, spawnId) => {
      const map = data.tiledMaps.find(({ id }) => id === mapId)
      return (map && getMonsterSpawnDefinitions(data, map).find((spawn) => spawn.spawnId === spawnId)?.baseExp) ?? 0
    })
  const reward = createMemoryPersonalLootRepository(data, characters, ground, spawnExperience, { ...rewardOptions, nowUtcMilliseconds })
  return { ground, characters, reward, repository }
}
