import { loadGrayboxGameData, monsterMaxHpAtLevel } from '@viesma/game-data'
import { expect, test } from 'vitest'
import { createMonsterFixture, stepMonsterFixture } from '../src/index.ts'

const data = loadGrayboxGameData()
const map = data.tiledMaps.find(({ id }) => id === 'm1')
const spawn = map.monsterSpawns.find(({ id }) => id === 'spawn_slime_1')
const archetype = data.monsters.find(({ id }) => id === spawn.monsterArchetypeId)
const definition = {
  spawn,
  patrolSpeed: archetype.patrolSpeed,
  maxHp: Number(monsterMaxHpAtLevel(archetype, spawn.level, data.monsterScaling)),
}

test('replays a stable ground patrol from validated M1 coordinates without drifting off the floor', () => {
  const floor = map.colliders.find(({ id }) => id === spawn.floorId)
  const events = new Set()
  function replay() {
    const initial = createMonsterFixture('monster-1', definition)
    expect(initial.position).toEqual(spawn.position)
    expect(initial.position).not.toBe(spawn.position)
    let state = initial
    const trace = []
    for (let frame = 0; frame < 96; frame++) {
      state = stepMonsterFixture(state, events)
      expect(state).toMatchObject({ monsterId: 'monster-1', hp: 71, position: { y: floor.bounds.origin.y } })
      expect(state.position.x).toBeGreaterThanOrEqual(spawn.patrolMinX)
      expect(state.position.x).toBeLessThanOrEqual(spawn.patrolMaxX)
      trace.push([state.position.x, state.facing])
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

test('applies a nonlethal test HP value and removes the fixture without combat', () => {
  const initial = createMonsterFixture('monster-1', definition)
  const changed = stepMonsterFixture(initial, new Set(['test-hp']))
  expect(initial.hp).toBe(71)
  expect(changed.hp).toBe(35)
  expect(stepMonsterFixture(changed, new Set()).hp).toBe(35)
  expect(stepMonsterFixture(changed, new Set(['remove', 'test-hp']))).toBeUndefined()
})
