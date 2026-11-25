import { monsterAttackAtLevel, monsterDefenseAtLevel, monsterMaxHpAtLevel, type GameData, type NormalizedMap } from '@viesma/game-data'
import type { MonsterSpawnDefinition } from '@viesma/simulation'

export function getMonsterSpawnDefinitions(data: GameData, map: NormalizedMap): (MonsterSpawnDefinition & { readonly baseExp: number })[] {
  const manifest = data.world.maps.find(({ id }) => id === map.id)
  if (!manifest) throw new RangeError(`Missing validated map definition for ${map.id}`)
  if (manifest.recommendedLevels === null) return []
  const archetypes = new Map(data.monsters.map((archetype) => [archetype.id, archetype]))
  return map.monsterSpawns.map((spawn) => {
    const archetype = archetypes.get(spawn.monsterArchetypeId)
    if (!archetype || archetype.movement !== spawn.movement) throw new RangeError(`Invalid archetype for ${map.id}/${spawn.id}`)
    const bounds =
      spawn.movement === 'ground'
        ? { min: { x: spawn.patrolMinX, y: spawn.position.y }, max: { x: spawn.patrolMaxX, y: spawn.position.y } }
        : {
            min: spawn.flightBounds.origin,
            max: {
              x: spawn.flightBounds.origin.x + spawn.flightBounds.width,
              y: spawn.flightBounds.origin.y + spawn.flightBounds.height,
            },
          }
    return {
      spawnId: spawn.id,
      archetypeId: archetype.id,
      origin: spawn.position,
      bounds,
      movement: spawn.movement,
      maxHp: Number(monsterMaxHpAtLevel(archetype, spawn.level, data.monsterScaling)),
      baseExp: archetype.baseExp * spawn.level,
      patrolSpeed: archetype.patrolSpeed,
      chaseSpeed: archetype.chaseSpeed,
      attackReach: archetype.attackReach,
      attack: Number(monsterAttackAtLevel(archetype, spawn.level, data.monsterScaling)),
      defense: Number(monsterDefenseAtLevel(archetype, spawn.level, data.monsterScaling)),
      damageType: archetype.damageType,
    }
  })
}
