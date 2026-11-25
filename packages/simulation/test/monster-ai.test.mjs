import {
  initialPhysicsBalance,
  loadGrayboxGameData,
  monsterAttackAtLevel,
  monsterDefenseAtLevel,
  monsterMaxHpAtLevel,
} from '@viesma/game-data'
import { positionQuantum } from '@viesma/physics'
import { expect, test } from 'vitest'
import { createMonsterMovement, createPlayer, createSeededRng, fixedDeltaSeconds, spawnMonsters, step } from '../src/index.ts'

const { monsters, monsterScaling } = loadGrayboxGameData()
const origin = { x: 1000, y: 600 }

function definition(archetypeId = 'slime', bounds = { min: { x: 100, y: 600 }, max: { x: 2000, y: 600 } }) {
  const archetype = monsters.find(({ id }) => id === archetypeId)
  return {
    spawnId: `spawn_${archetypeId}`,
    archetypeId,
    origin,
    bounds,
    movement: archetype.movement,
    maxHp: Number(monsterMaxHpAtLevel(archetype, 2, monsterScaling)),
    patrolSpeed: archetype.patrolSpeed,
    chaseSpeed: archetype.chaseSpeed,
    attackReach: archetype.attackReach,
    attack: Number(monsterAttackAtLevel(archetype, 2, monsterScaling)),
    defense: Number(monsterDefenseAtLevel(archetype, 2, monsterScaling)),
    damageType: archetype.damageType,
  }
}

function player(characterId, x, y = origin.y, fields = {}) {
  const { bodyWidthWorldUnits, bodyHeightWorldUnits } = initialPhysicsBalance
  return { ...createPlayer(characterId, { x: x - bodyWidthWorldUnits / 2, y: y - bodyHeightWorldUnits }, true), ...fields }
}

function harness({ definitions = [definition()], seed = 1, colliders = [] } = {}) {
  const rng = createSeededRng(seed)
  let nextMonster = 0
  let nextEncounter = 0
  const ids = {
    nextMonsterId: () => `monster-${++nextMonster}`,
    nextEncounterId: () => `encounter-${++nextEncounter}`,
  }
  const move = createMonsterMovement(colliders)
  let state = {
    tick: 0,
    map: { mapId: 'fixture', mapInstanceId: 'room', players: [], monsters: spawnMonsters(definitions, 12, ids, rng), attacks: [] },
  }
  return {
    get state() {
      return state
    },
    get monster() {
      return state.map.monsters[0]
    },
    until(end, players = []) {
      while (state.tick < end) {
        const result = step({ ...state, map: { ...state.map, players } }, [], fixedDeltaSeconds, {
          rng,
          ids: { nextAttackId: () => 'unused' },
          tick: state.tick + 1,
          playerController: (body) => body,
          monsters: { move, ...ids },
        })
        expect(result.events).toEqual([])
        state = result.state
      }
      return state.map.monsters[0]
    },
    setMonsterHp(hp) {
      state = { ...state, map: { ...state.map, monsters: state.map.monsters.map((monster) => ({ ...monster, hp })) } }
    },
  }
}

test('scans on six-tick boundaries, breaks ties by characterId and switches to a nearer valid target', () => {
  const h = harness()
  const players = [player('z-last', 1100), player('a-first', 920)]
  expect(h.monster.behavior).toEqual({ kind: 'spawning' })
  expect(h.until(5, players)).toMatchObject({ position: { x: 1010 }, behavior: { kind: 'patrol' } })
  expect(h.until(6, players)).toMatchObject({
    position: { x: 1006.6669921875 },
    behavior: { kind: 'chase', aggro: { target: { characterId: 'a-first', lifeStartedTick: 0 }, lostAt: null } },
  })
  const changed = [player('z-last', 1040), player('a-first', 900)]
  expect(h.until(11, changed).behavior.aggro.target.characterId).toBe('a-first')
  expect(h.until(12, changed).behavior.aggro.target.characterId).toBe('z-last')
})

test('rejects nearer dead and protected bodies, then admits a body exactly when protection expires', () => {
  const h = harness()
  const dead = player('dead', 1010, origin.y, { action: { kind: 'death', diedAtTick: 0, cause: 'void' } })
  const shielded = player('protected', 1014, origin.y, { spawnProtected: true })
  const alive = player('alive', 1090)
  expect(h.until(6, [dead, shielded, alive]).behavior.aggro.target.characterId).toBe('alive')
  expect(h.until(12, [shielded]).behavior).toEqual({ kind: 'chase', aggro: { target: null, lostAt: 7 } })
  expect(h.until(89, [shielded]).behavior.aggro.target).toBeNull()
  expect(h.until(90, [shielded]).behavior.aggro.target.characterId).toBe('protected')
})

test('includes the aggro and lose-target distances and returns on the ninetieth lost tick', () => {
  const outside = harness()
  expect(outside.until(6, [player('a', 1330 + positionQuantum)]).behavior).toEqual({ kind: 'patrol' })
  const h = harness()
  expect(h.until(6, [player('a', 1330)]).behavior.aggro.target.characterId).toBe('a')
  expect(h.until(7, [player('a', h.monster.position.x + 480)]).behavior.aggro.target.characterId).toBe('a')
  expect(h.until(8, [player('a', h.monster.position.x + 480 + positionQuantum)]).behavior).toEqual({
    kind: 'chase',
    aggro: { target: null, lostAt: 8 },
  })
  expect(h.until(97).behavior.kind).toBe('chase')
  expect(h.until(98).behavior).toEqual({ kind: 'return' })
})

test('locks an attack to its original life and advances exact phases and cooldown with combat disabled', () => {
  const h = harness()
  const a = player('a', 1046)
  const b = player('b', 1010)
  expect(h.until(6, [a]).behavior).toMatchObject({
    kind: 'attack',
    startedAt: 6,
    action: { phase: 'windup', target: { characterId: 'a', lifeStartedTick: 0 } },
  })
  expect(h.until(14, [a, b]).behavior).toMatchObject({ aggro: { target: { characterId: 'b' } }, action: { phase: 'windup' } })
  expect(h.until(15, [a, b]).behavior.action).toEqual({ phase: 'active', target: { characterId: 'a', lifeStartedTick: 0 } })
  expect(h.state.map.players.map(({ vitals }) => vitals.hp)).toEqual([50, 50])
  expect(h.state.map.attacks).toEqual([])
  expect(h.until(16, [b]).behavior.action).toEqual({ phase: 'recovery' })
  expect(h.until(23, [b]).behavior.action).toEqual({ phase: 'recovery' })
  expect(h.until(24, [b]).behavior.kind).toBe('chase')
  expect(h.until(35, [b]).behavior.kind).toBe('chase')
  expect(h.until(36, [b]).behavior).toMatchObject({ kind: 'attack', startedAt: 36, action: { phase: 'windup' } })
  expect(h.until(45, [player('b', 1010, origin.y, { lifeStartedTick: 40 })]).behavior.action).toEqual({ phase: 'active', target: null })
})

test.each([
  ['removed', []],
  ['out of reach', [player('a', 1046 + positionQuantum)]],
  ['protected', [player('a', 1010, origin.y, { spawnProtected: true })]],
])('invalidates an attack before active when the locked body is %s', (_reason, activePlayers) => {
  const h = harness()
  const original = player('a', 1010)
  expect(h.until(14, [original]).behavior.action.phase).toBe('windup')
  expect(h.until(15, activePlayers).behavior.action).toEqual({ phase: 'active', target: null })
})

test('keeps a windup invalidated after its target body is removed and then returns before active', () => {
  const h = harness()
  const original = player('a', 1010)
  expect(h.until(13, [original]).behavior.action.target.characterId).toBe('a')
  expect(h.until(14).behavior.action).toEqual({ phase: 'windup', target: null })
  expect(h.until(15, [original]).behavior.action).toEqual({ phase: 'active', target: null })
})

test('stops Mushroom at its floor edge, returns, and does not repeatedly chase an unreachable platform', () => {
  const bounds = { min: { x: 900, y: 600 }, max: { x: 1100, y: 600 } }
  const h = harness({ definitions: [definition('mushroom', bounds)] })
  const upperPlatform = player('a', 1100, 545)
  expect(h.until(6, [upperPlatform]).behavior.kind).toBe('patrol')
  expect(h.until(12, [player('a', 1080)]).behavior.kind).toBe('chase')
  const offEdge = player('a', 1200)
  let tick = 13
  while (tick <= 50 && h.until(tick, [offEdge]).behavior.kind !== 'return') tick++
  expect(h.monster).toMatchObject({ position: { x: 1100, y: 600 }, behavior: { kind: 'return' } })
  for (let t = tick + 1; t <= 300; t++) {
    const monster = h.until(t, [upperPlatform, player('b', 1200)])
    expect(monster.position.y).toBe(600)
    expect(monster.position.x).toBeGreaterThanOrEqual(900)
    expect(monster.position.x).toBeLessThanOrEqual(1100)
    expect(['return', 'patrol']).toContain(monster.behavior.kind)
  }
  expect(h.monster.encounterId).toBe('encounter-2')
})

test('clips Bat flight against a thin solid, slides along the face and returns inside the flight box', () => {
  const bounds = { min: { x: 900, y: 500 }, max: { x: 1100, y: 700 } }
  const wall = { kind: 'solid', bounds: { origin: { x: 1028, y: 500 }, width: 1, height: 200 } }
  const h = harness({ definitions: [definition('bat', bounds)], colliders: [wall] })
  const acrossWall = player('a', 1080, 640)
  const trace = []
  for (let t = 1; t <= 95; t++) {
    const { position, behavior } = h.until(t, t <= 35 ? [acrossWall] : [])
    expect(position.x).toBeGreaterThanOrEqual(900)
    expect(position.x).toBeLessThanOrEqual(1028)
    expect(position.y).toBeGreaterThanOrEqual(500)
    expect(position.y).toBeLessThanOrEqual(700)
    trace.push([position.x, position.y, behavior.kind])
  }
  expect(trace[0]).toEqual([997, 600, 'patrol'])
  expect(trace).toContainEqual([1028, 640, 'return'])
  expect(trace).toContainEqual([1000, 600, 'patrol'])
  const sweep = createMonsterMovement([wall, { kind: 'solid', bounds: { origin: { x: 900, y: 570 }, width: 100, height: 1 } }])
  expect(sweep({ x: 1000, y: 600 }, { x: 1070, y: 620 })).toEqual({ x: 1028, y: 620 })
  expect(sweep({ x: 980, y: 600 }, { x: 980, y: 545 })).toEqual({ x: 980, y: 571 })
})

test('clamps a pursuing Bat at the boundary of its flight box and returns when it cannot reach', () => {
  const bounds = { min: { x: 900, y: 500 }, max: { x: 1100, y: 700 } }
  const h = harness({ definitions: [definition('bat', bounds)] })
  expect(h.until(6, [player('a', 1000, 665)]).behavior.kind).toBe('chase')
  for (let tick = 7; tick <= 45; tick++) {
    const monster = h.until(tick, [player('a', 1000, 770)])
    expect(monster.position.y).toBeLessThanOrEqual(700)
    if (monster.behavior.kind === 'return') {
      expect(monster.position).toEqual({ x: 1000, y: 700 })
      expect(h.until(75).encounterId).toBe('encounter-2')
      return
    }
  }
  expect(h.monster.behavior.kind).toBe('return')
})

test('returns before crossing the spawn leash and restores HP with a fresh encounter', () => {
  const h = harness()
  const original = h.monster
  const old = { monsterId: original.monsterId, encounterId: original.encounterId }
  h.setMonsterHp(35)
  expect(h.until(1).hp).toBe(35)
  h.until(20, [player('a', 1270)])
  h.until(75, [player('a', 1470)])
  let tick = 76
  while (tick <= 200 && h.until(tick, [player('a', 1580)]).behavior.kind !== 'return') tick++
  expect(h.monster).toMatchObject({ hp: 35, position: { x: 1509.951171875 }, behavior: { kind: 'return' } })
  expect(h.monster.encounterId).toBe(old.encounterId)
  while (tick <= 400 && h.monster.behavior.kind === 'return') h.until(++tick)
  expect(h.monster).toMatchObject({
    position: origin,
    hp: 71,
    encounterId: 'encounter-2',
    monsterId: old.monsterId,
    lastAttackStartedTick: null,
    behavior: { kind: 'patrol' },
  })
  expect(h.until(tick + 1)).toMatchObject({ hp: 71, encounterId: 'encounter-2' })
  const nextScan = Math.ceil((tick + 2) / 6) * 6
  expect(h.until(nextScan, [player('a', 1010)])).toMatchObject({ lastAttackStartedTick: nextScan, behavior: { kind: 'attack' } })
  expect(h.until(nextScan + 100)).toMatchObject({ lastAttackStartedTick: null, encounterId: 'encounter-3', hp: 71 })
})

test('replays exact mixed-archetype traces with the same seed and stable IDs', () => {
  const bounds = { min: { x: 900, y: 500 }, max: { x: 1100, y: 700 } }
  const traces = (seed, definitions) => {
    const h = harness({ definitions, seed })
    return Array.from({ length: 50 }, (_, frame) => {
      h.until(frame + 1, [player('z', 1080, 563), player('a', 1200)])
      return h.state.map.monsters.map(({ monsterId, spawn, encounterId, position, facing, behavior }) => [
        monsterId,
        spawn.archetypeId,
        encounterId,
        position.x,
        position.y,
        facing,
        behavior.kind,
      ])
    })
  }
  const definitions = [definition(), definition('mushroom'), definition('bat', bounds)]
  const trace = traces(1, definitions)
  expect(trace).toEqual(traces(1, definitions.toReversed()))
  expect(trace[0]).toEqual([
    ['monster-1', 'bat', 'encounter-1', 997, 600, 'left', 'patrol'],
    ['monster-2', 'mushroom', 'encounter-2', 1001.6669921875, 600, 'right', 'patrol'],
    ['monster-3', 'slime', 'encounter-3', 1002, 600, 'right', 'patrol'],
  ])
  expect(traces(1000, definitions)[0][0]).toEqual(['monster-1', 'bat', 'encounter-1', 1003, 600, 'right', 'patrol'])
})
