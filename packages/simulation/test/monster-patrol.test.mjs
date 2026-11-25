import { loadGrayboxGameData, monsterAttackAtLevel, monsterDefenseAtLevel, monsterMaxHpAtLevel } from '@viesma/game-data'
import { expect, test } from 'vitest'
import { createMonsterMovement, createSeededRng, fixedDeltaSeconds, spawnMonsters, step } from '../src/index.ts'

const data = loadGrayboxGameData()
const map = data.tiledMaps.find(({ id }) => id === 'm1')
const spawn = map.monsterSpawns.find(({ id }) => id === 'spawn_slime_1')
const archetype = data.monsters.find(({ id }) => id === spawn.monsterArchetypeId)
const definition = {
  spawnId: spawn.id,
  archetypeId: archetype.id,
  origin: spawn.position,
  movement: 'ground',
  bounds: { min: { x: spawn.patrolMinX, y: spawn.position.y }, max: { x: spawn.patrolMaxX, y: spawn.position.y } },
  patrolSpeed: archetype.patrolSpeed,
  chaseSpeed: archetype.chaseSpeed,
  attackReach: archetype.attackReach,
  maxHp: Number(monsterMaxHpAtLevel(archetype, spawn.level, data.monsterScaling)),
  attack: Number(monsterAttackAtLevel(archetype, spawn.level, data.monsterScaling)),
  defense: Number(monsterDefenseAtLevel(archetype, spawn.level, data.monsterScaling)),
  damageType: archetype.damageType,
}
const initialState = () => ({
  tick: 0,
  map: {
    mapId: 'm1',
    mapInstanceId: 'room',
    players: [],
    monsters: spawnMonsters(
      [definition],
      1,
      { nextMonsterId: () => 'monster-1', nextEncounterId: () => 'encounter-1' },
      createSeededRng(1)
    ),
    attacks: [],
  },
})

const move = createMonsterMovement(map.colliders)
function advance(state) {
  return step(state, [], fixedDeltaSeconds, {
    tick: state.tick + 1,
    rng: createSeededRng(1),
    ids: { nextAttackId: () => 'unused' },
    monsters: {
      move,
      nextMonsterId: () => 'unused',
      nextEncounterId: () => 'unused',
    },
  }).state
}

test('replays a stable ground patrol from validated M1 coordinates without drifting off the floor', () => {
  const floor = map.colliders.find(({ id }) => id === spawn.floorId)
  function replay() {
    let state = initialState()
    const [initial] = state.map.monsters
    expect(initial.position).toEqual(spawn.position)
    expect(initial.position).not.toBe(spawn.position)
    const trace = []
    for (let frame = 0; frame < 96; frame++) {
      state = advance(state)
      const [monster] = state.map.monsters
      expect(monster).toMatchObject({ monsterId: 'monster-1', hp: 71, position: { y: floor.bounds.origin.y } })
      expect(monster.position.x).toBeGreaterThanOrEqual(spawn.patrolMinX)
      expect(monster.position.x).toBeLessThanOrEqual(spawn.patrolMaxX)
      trace.push([monster.position.x, monster.facing])
    }
    expect(initial.position).toEqual(spawn.position)
    return trace
  }
  const trace = replay()
  expect(trace).toEqual(replay())
  expect(trace[0]).toEqual([467, 'right'])
  expect(trace[23]).toEqual([513, 'left'])
  expect(trace[71]).toEqual([417, 'right'])
  expect(trace[95]).toEqual([465, 'right'])
})
