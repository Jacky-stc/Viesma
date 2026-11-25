import {
  deriveCombatStats,
  getBeginnerCombatStats,
  getStarterWeaponModifiers,
  initialPhysicsBalance,
  loadGrayboxGameData,
  monsterAttackAtLevel,
  monsterDefenseAtLevel,
} from '@viesma/game-data'
import { positionQuantum } from '@viesma/physics'
import { expect, test } from 'vitest'
import {
  allocateAttributes,
  createCharacterAggregate,
  createMonsterMovement,
  createPlayer,
  createPlayerController,
  createSeededRng,
  createSolidObstructionTest,
  fixedDeltaSeconds,
  grantExperience,
  spawnMonsters,
  step,
} from '../src/index.ts'

const data = loadGrayboxGameData()
const playerStats = getBeginnerCombatStats(data)
const floorY = 600
const floor = { kind: 'solid', bounds: { origin: { x: 0, y: floorY }, width: 2200, height: 100 } }

function player(characterId = 'player-a', x = 1000, fields = {}) {
  const { bodyWidthWorldUnits: width, bodyHeightWorldUnits: height } = initialPhysicsBalance
  return { ...createPlayer(characterId, { x: x - width / 2, y: floorY - height }, true), ...fields }
}

function monster(monsterId, x, { y = floorY, archetypeId = 'slime', target = null, startedAt = 0, hp, ...fields } = {}) {
  const archetype = data.monsters.find(({ id }) => id === archetypeId)
  const origin = { x, y }
  const [body] = spawnMonsters(
    [
      {
        spawnId: 'spawn-fixture',
        archetypeId,
        origin,
        bounds: { min: { x: 800, y }, max: { x: 1200, y } },
        movement: archetype.movement,
        maxHp: archetype.baseHp,
        patrolSpeed: archetype.patrolSpeed,
        chaseSpeed: archetype.chaseSpeed,
        attackReach: archetype.attackReach,
        attack: Number(monsterAttackAtLevel(archetype, 1, data.monsterScaling)),
        defense: Number(monsterDefenseAtLevel(archetype, 1, data.monsterScaling)),
        damageType: archetype.damageType,
      },
    ],
    1,
    { nextMonsterId: () => monsterId, nextEncounterId: () => 'encounter-0' },
    createSeededRng(1)
  )
  return {
    ...body,
    hp: hp ?? body.hp,
    lastAttackStartedTick: startedAt,
    behavior: {
      kind: 'attack',
      startedAt,
      aggro: target ? { target, lostAt: null } : { target: null, lostAt: 0 },
      action: { phase: 'windup', target },
    },
    ...fields,
  }
}

function input(seq, fields = {}) {
  return {
    kind: 'input',
    characterId: 'player-a',
    lifeStartedTick: 0,
    seq,
    moveX: 0,
    jumpPressed: false,
    attackPressed: true,
    ...fields,
  }
}

function harness({
  players = [player()],
  monsters = [],
  colliders = [],
  mapId = 'm1',
  seed = 1,
  stats = playerStats,
  tick = 0,
  nextAttackId,
  receiptFor,
  rng = createSeededRng(seed),
} = {}) {
  let state = { tick, map: { mapId, mapInstanceId: 'room', players, monsters, attacks: [] } }
  let attackCount = 0
  let encounterCount = 0
  let monsterCount = 0
  const geometry = [floor, ...colliders]
  const context = {
    rng,
    ids: { nextAttackId: nextAttackId ?? (() => `swing-${++attackCount}`) },
    playerController: createPlayerController({ bounds: { origin: { x: 0, y: 0 }, width: 2200, height: 800 }, colliders: geometry }),
    monsters: {
      move: createMonsterMovement(geometry),
      nextMonsterId: () => `respawned-${++monsterCount}`,
      nextEncounterId: () => `encounter-${++encounterCount}`,
      receiptFor,
    },
    combat: {
      playerStats: stats,
      isObstructed: createSolidObstructionTest(geometry),
      balanceVersion: data.balanceVersion,
      participant: () => ({ connected: true }),
    },
  }
  const trace = []
  const advance = (commands = [], options = {}) => {
    const result = step(state, commands, fixedDeltaSeconds, { ...context, tick: state.tick + 1, ...options })
    state = result.state
    trace.push(result)
    return result.events
  }
  return {
    get state() {
      return state
    },
    get trace() {
      return trace
    },
    get body() {
      return state.map.players[0]
    },
    get monsters() {
      return state.map.monsters
    },
    replace(fields) {
      state = { ...state, map: { ...state.map, ...fields } }
    },
    advance,
    until(end) {
      const events = []
      while (state.tick < end) events.push(...advance())
      return events
    },
  }
}

const targetA = { characterId: 'player-a', lifeStartedTick: 0 }

test('consumes attack edges at acceptance, opens only tick T+4, ends at T+14, and permits a fresh edge at T+18', () => {
  const h = harness({ monsters: [monster('victim', 1035)] })
  expect(h.advance([input(1), input(1)])).toEqual([])
  expect(h.body.action).toMatchObject({ kind: 'attack', facing: 'right', swing: { attackId: 'swing-1', acceptedTick: 1, inputSeq: 1 } })
  expect(h.until(4)).toEqual([])
  expect(h.advance([input(2)])).toMatchObject([{ kind: 'monsterDamaged', attackId: 'swing-1', tick: 5, damage: 20 }])
  expect(h.until(14)).toEqual([])
  expect(h.body.action.kind).toBe('attack')
  h.advance()
  expect(h.body.action.kind).toBe('none')
  h.until(17)
  h.advance([input(3)])
  expect(h.body.action.kind).toBe('none')
  h.advance([input(4)])
  expect(h.body.action).toMatchObject({ kind: 'attack', swing: { attackId: 'swing-2', acceptedTick: 19, inputSeq: 4 } })
})

test('discards conflicting and stale attack edges and never buffers an unavailable one', () => {
  const h = harness()
  h.advance([input(1), input(1, { attackPressed: false })])
  expect(h.body.action.kind).toBe('none')
  h.advance([input(2)])
  h.advance([input(3)])
  h.until(20)
  h.advance([input(3)])
  expect(h.body.action.kind).toBe('none')
  h.advance([input(4)])
  expect(h.body.action).toMatchObject({ swing: { attackId: 'swing-2', acceptedTick: 22 } })
})

test.each([
  [0, 0, true],
  [48, 0, true],
  [48 + positionQuantum, 0, false],
  [-positionQuantum, 0, false],
  [30, -20, true],
  [30, 20, true],
  [30, -20 - positionQuantum, false],
  [30, 20 + positionQuantum, false],
])('places monster center relative to the inclusive forward rectangle at (%s, %s)', (dx, dy, hits) => {
  const h = harness({ monsters: [monster('victim', 1000 + dx, { y: floorY - 12 + dy })] })
  h.advance([input(1)])
  expect(h.until(5)).toHaveLength(hits ? 1 : 0)
})

test('uses the active-tick position while locking the accepted facing through movement reversals', () => {
  const h = harness({ monsters: [monster('originally-behind', 996), monster('newly-behind', 960), monster('old-edge', 1048)] })
  h.advance([input(1)])
  h.advance([input(2, { moveX: -1, attackPressed: false })])
  expect(h.body).toMatchObject({ facing: 'left', action: { facing: 'right' } })
  expect(h.until(5)).toMatchObject([{ monsterId: 'originally-behind' }])
  const left = harness({ monsters: [monster('left', 970), monster('right', 1030)] })
  left.advance([input(1, { moveX: -1 })])
  expect(left.until(5)).toMatchObject([{ monsterId: 'left' }])
})

test('keeps airborne physics and permits a jump and attack edge on the same tick', () => {
  const h = harness()
  h.advance([input(1, { moveX: 1, jumpPressed: true })])
  expect(h.body).toMatchObject({ locomotion: 'jump', action: { kind: 'attack' }, physics: { grounded: false } })
  const y = h.body.position.y
  h.until(5)
  expect(h.body.position.y).toBeLessThan(y)
  expect(h.body.physics.velocity.x).toBeGreaterThan(0)
})

test.each([
  ['solid', 565, false],
  ['oneWay', 565, true],
  ['solid', 566, true],
])('uses the center-to-center segment through a %s at y=%s', (kind, y, hits) => {
  const colliders = [{ kind, bounds: { origin: { x: 1020, y }, width: 1, height: 3 } }]
  const h = harness({ colliders, monsters: [monster('target', 1040, { y: 568 })] })
  h.advance([input(1)])
  expect(h.until(5)).toHaveLength(hits ? 1 : 0)
})

test('sorts eligible monsters by ID, caps the swing at three, and rolls only on those hits', () => {
  let draws = 0
  const rng = {
    nextUnit: () => {
      draws++
      return 0.8
    },
  }
  const monsters = ['e', 'd', 'b', 'c', 'a'].map((id, offset) => monster(id, 1014 + offset))
  const h = harness({ monsters, rng })
  h.advance([input(1)])
  expect(h.until(5).map(({ monsterId }) => monsterId)).toEqual(['a', 'b', 'c'])
  expect(h.until(9)).toEqual([])
  expect(draws).toBe(3)
  expect(h.monsters.map(({ monsterId, hp }) => [monsterId, hp])).toEqual([
    ['a', 40],
    ['b', 40],
    ['c', 40],
    ['d', 60],
    ['e', 60],
  ])
})

test('ignores a duplicate swing ID during active resolution and orders sources by character ID', () => {
  const h = harness({
    players: [player('player-z'), player()],
    monsters: [monster('target', 1020)],
    nextAttackId: () => 'duplicate',
  })
  h.advance([input(1, { characterId: 'player-z' }), input(7)])
  expect(h.until(5)).toMatchObject([{ attackId: 'duplicate', characterId: 'player-a', monsterId: 'target' }])
  expect(h.monsters[0].hp).toBe(40)
})

test('applies seeded critical and ordinary damage, minimum damage, floor rounding, and caps overkill', () => {
  expect(playerStats).toEqual({ attackPower: 21, physicalDefense: 1, magicDefense: 2, criticalChanceBps: 500 })
  const monsters = [monster('a', 1020, { hp: 8 }), monster('b', 1020), monster('c', 1020)]
  monsters[0].spawn = { ...monsters[0].spawn, defense: 2 }
  monsters[2].spawn = { ...monsters[2].spawn, defense: 100 }
  const h = harness({ monsters, seed: 1972 })
  h.advance([input(1)])
  expect(h.until(5)).toMatchObject([
    { monsterId: 'a', damage: 28, effectiveDamage: 8, critical: true, lethal: true },
    { kind: 'monsterDeathClaimed', intent: { claim: { monsterId: 'a' }, groups: [{ effectiveDamage: 8 }] } },
    { monsterId: 'b', damage: 20, effectiveDamage: 20, critical: false, lethal: false },
    { monsterId: 'c', damage: 1, effectiveDamage: 1, lethal: false },
  ])
  expect(h.monsters[0]).toMatchObject({ hp: 0, encounterId: 'encounter-0', behavior: { kind: 'rewardPending' } })
})

test.each([
  [499, true],
  [500, false],
])('treats critical roll %s as a basis-point boundary', (roll, critical) => {
  const h = harness({ monsters: [monster('target', 1020)], rng: { nextUnit: () => (roll + 0.5) / 10000 } })
  h.advance([input(1)])
  expect(h.until(5)).toMatchObject([{ critical }])
})

test.each([
  ['slime', 36, 5],
  ['mushroom', 44, 8],
  ['bat', 40, 6],
])('applies %s damage with its applicable defense at inclusive reach %s', (archetypeId, reach, damage) => {
  const h = harness({ monsters: [monster('target', 1000 + reach, { archetypeId, target: targetA })] })
  expect(h.until(8)).toEqual([])
  expect(h.advance()).toMatchObject([{ kind: 'playerDamaged', damage, effectiveDamage: damage, tick: 9 }])
  expect(h.body).toMatchObject({ vitals: { hp: 50 - damage, mp: 30 }, action: { kind: 'hurt', ticksRemaining: 6 } })
  expect(h.until(29)).toEqual([])
  expect(h.advance()).toEqual([])
  expect(h.monsters[0].behavior).toMatchObject({ kind: 'attack', startedAt: 30, action: { phase: 'windup' } })
})

test('resolves updated attack power and both defenses for the affected character only', () => {
  const owner = createCharacterAggregate('player-a')
  const { character } = allocateAttributes(grantExperience(owner, 400, data.progression), { str: 4, dex: 4, int: 2, luk: 0 })
  const updated = deriveCombatStats(character.level, character.baseAttributes, getStarterWeaponModifiers(data))
  const stats = (characterId) => (characterId === owner.characterId ? updated : playerStats)
  const outgoing = harness({ monsters: [monster('slime', 1035)], stats, rng: { nextUnit: () => 0.8 } })
  outgoing.advance([input(1)])
  expect(outgoing.until(5)).toMatchObject([{ kind: 'monsterDamaged', damage: 30 }])

  for (const [archetypeId, ownerDamage, otherDamage] of [
    ['slime', 4, 5],
    ['bat', 5, 6],
  ]) {
    const other = { characterId: 'player-b', lifeStartedTick: 0 }
    const incoming = harness({
      players: [player(), player(other.characterId, 1100)],
      monsters: [monster('first', 1020, { archetypeId, target: targetA }), monster('second', 1120, { archetypeId, target: other })],
      stats,
    })
    expect(incoming.until(9)).toMatchObject([
      { kind: 'playerDamaged', characterId: owner.characterId, damage: ownerDamage },
      { kind: 'playerDamaged', characterId: other.characterId, damage: otherDamage },
    ])
  }
})

test('monster damage floors at one, respects walls and uses real range rather than a target supplied by input', () => {
  const min = harness({ monsters: [monster('a', 1035, { target: targetA })], stats: { ...playerStats, physicalDefense: 100 } })
  expect(min.until(9)).toMatchObject([{ damage: 1 }])
  const wall = { kind: 'solid', bounds: { origin: { x: 1020, y: 565 }, width: 1, height: 30 } }
  const blocked = harness({ monsters: [monster('a', 1035, { target: targetA })], colliders: [wall] })
  expect(blocked.until(9)).toEqual([])
  const distant = harness({ monsters: [monster('a', 1036 + positionQuantum, { target: targetA })] })
  expect(distant.until(9)).toEqual([])
})

test('revalidates each monster hit and enforces one 30-tick i-frame per player', () => {
  const h = harness({
    players: [player(), player('player-b', 990)],
    monsters: [
      monster('b', 1020, { target: targetA }),
      monster('a', 1020, { target: targetA }),
      monster('c', 1020, { target: { characterId: 'player-b', lifeStartedTick: 0 } }),
    ],
  })
  expect(h.until(9)).toMatchObject([
    { monsterId: 'a', characterId: 'player-a' },
    { monsterId: 'c', characterId: 'player-b' },
  ])
  h.until(37)
  h.replace({ monsters: [monster('first', 1020, { target: targetA, startedAt: 29 })] })
  expect(h.advance()).toEqual([])
  h.replace({ monsters: [monster('second', 1020, { target: targetA, startedAt: 30 })] })
  expect(h.advance()).toMatchObject([{ monsterId: 'second', tick: 39 }])
  expect(h.body.vitals.hp).toBe(40)
})

test('cancels windup on damage, rejects attack and jump during Hurt, and keeps the original cooldown', () => {
  const h = harness({ monsters: [monster('a', 1034, { target: targetA })] })
  h.until(7)
  h.advance([input(1)])
  expect(h.advance()).toMatchObject([{ kind: 'playerDamaged' }])
  h.advance([input(2, { jumpPressed: true })])
  expect(h.body).toMatchObject({ physics: { grounded: true }, action: { kind: 'hurt', ticksRemaining: 5 } })
  expect(h.until(14)).toEqual([])
  expect(h.body.action).toEqual({ kind: 'hurt', ticksRemaining: 1 })
  h.advance([input(3, { jumpPressed: true })])
  expect(h.body).toMatchObject({ locomotion: 'jump', action: { kind: 'none' } })
  h.until(25)
  h.advance([input(4)])
  expect(h.body.action).toMatchObject({ kind: 'attack', swing: { acceptedTick: 26 } })
})

test('an accepted attack removes spawn protection and Village skips both sides of combat', () => {
  const protectedBody = player('player-a', 1000, { spawnProtected: true })
  const h = harness({ players: [protectedBody], monsters: [monster('a', 1030, { target: targetA })] })
  expect(h.until(9)).toEqual([])
  expect(h.body.spawnProtected).toBe(true)
  h.advance([input(1)])
  expect(h.body.spawnProtected).toBe(false)
  expect(h.until(14)).toMatchObject([{ kind: 'monsterDamaged' }])
  const safe = harness({ mapId: 'village', monsters: [monster('a', 1030, { target: targetA })] })
  safe.advance([input(1)])
  expect(safe.until(9)).toEqual([])
  expect(safe.body).toMatchObject({ vitals: { hp: 50 }, action: { kind: 'none' } })
  expect(safe.monsters[0].hp).toBe(60)
})

test('a same-tick player lethal hit stops the monster and the second player from damaging it', () => {
  const h = harness({ players: [player('player-b'), player()], monsters: [monster('a', 1030, { target: targetA, hp: 10 })] })
  h.until(4)
  h.advance([input(1, { characterId: 'player-b' }), input(2)])
  expect(h.until(9)).toMatchObject([
    { kind: 'monsterDamaged', characterId: 'player-a', effectiveDamage: 10, lethal: true },
    { kind: 'monsterDeathClaimed', intent: { claim: { lethalAttackId: 'swing-1' } } },
  ])
  expect(h.body.vitals.hp).toBe(50)
  expect(h.until(20)).toEqual([])
  expect(h.monsters[0]).toMatchObject({ hp: 0, behavior: { kind: 'rewardPending' } })
})

test('replays permuted commands and players with 40 + 40 against 60 HP as 40 + 20 and one death intent', () => {
  const ids = ['player-a', 'player-b', 'player-c']
  function replay(order) {
    const h = harness({
      players: order.map((id) => player(id)),
      monsters: [monster('a', 1030)],
      stats: { ...playerStats, attackPower: 41, criticalChanceBps: 0 },
    })
    h.advance(order.map((characterId) => input(1, { characterId })))
    const events = h.until(5)
    expect(events).toMatchObject([
      { kind: 'monsterDamaged', characterId: 'player-a', damage: 40, effectiveDamage: 40, lethal: false },
      { kind: 'monsterDamaged', characterId: 'player-b', damage: 40, effectiveDamage: 20, lethal: true },
      {
        kind: 'monsterDeathClaimed',
        intent: {
          claim: { lethalAttackId: 'swing-2' },
          groups: [
            { groupKey: 'solo:player-a', effectiveDamage: 40, eligibleCharacterIds: ['player-a'] },
            { groupKey: 'solo:player-b', effectiveDamage: 20, eligibleCharacterIds: ['player-b'] },
          ],
        },
      },
    ])
    expect(h.monsters[0]).toMatchObject({ hp: 0, ledger: null, behavior: { kind: 'rewardPending' } })
    expect(h.until(40)).toEqual([])
    return h.trace
  }
  expect(replay(ids.toReversed())).toEqual(replay(ids))
})

test('ignores a duplicate attack ID on a later tick without changing HP, credit or RNG', () => {
  let draws = 0
  const h = harness({
    monsters: [monster('a', 1030)],
    nextAttackId: () => 'duplicate',
    rng: {
      nextUnit: () => {
        draws++
        return 0.5
      },
    },
  })
  h.advance([input(1)])
  expect(h.until(5)).toHaveLength(1)
  const ledger = h.monsters[0].ledger
  h.until(18)
  h.advance([input(2)])
  expect(h.until(23)).toEqual([])
  expect(h.monsters[0]).toMatchObject({ hp: 40, ledger })
  expect(draws).toBe(1)
})

test('uses the death lifecycle exactly once and cancels later same-tick attacks on the dead player', () => {
  const a = player()
  const h = harness({
    players: [{ ...a, vitals: { ...a.vitals, hp: 3 } }],
    monsters: [monster('a', 1030, { target: targetA }), monster('b', 1030, { target: targetA })],
  })
  expect(h.until(9)).toMatchObject([
    { kind: 'playerDamaged', damage: 5, effectiveDamage: 3 },
    { kind: 'playerDied', characterId: 'player-a', cause: 'damage', tick: 9 },
  ])
  expect(h.body).toMatchObject({ vitals: { hp: 0 }, action: { kind: 'death', diedAtTick: 9 }, movement: { moveX: 0 } })
  expect(h.until(60)).toEqual([])
})

test.each(['removed', 'dead', 'new life'])('invalidates a monster windup when its original target is %s', (reason) => {
  const h = harness({ monsters: [monster('a', 1030, { target: targetA })] })
  expect(h.until(7)).toEqual([])
  const unavailable = {
    removed: [],
    dead: [{ ...h.body, action: { kind: 'death', diedAtTick: 7 } }],
    'new life': [{ ...h.body, lifeStartedTick: 7 }],
  }
  h.replace({ players: unavailable[reason] })
  expect(h.advance()).toEqual([])
  h.replace({ players: [player()] })
  expect(h.advance()).toEqual([])
})

test('excludes dead, returning and removed monsters, and rejects a swing accepted before an encounter reset', () => {
  const reset = monster('reset', 1030, { hp: 5, behavior: { kind: 'return' } })
  const h = harness({
    players: [player('player-a', 1000, { lastHurtTick: 0 })],
    monsters: [
      reset,
      monster('dead', 1020, { hp: 0, behavior: { kind: 'rewardPending', deathId: 'pending' } }),
      monster('still-returning', 1035, { behavior: { kind: 'return' }, position: { x: 1035, y: 620 } }),
      monster('removed', 1030),
    ],
  })
  h.advance([input(1)])
  expect(h.monsters.find(({ monsterId }) => monsterId === 'reset')).toMatchObject({ encounterId: 'encounter-1', hp: 60 })
  h.replace({
    monsters: h.monsters
      .filter(({ monsterId }) => monsterId !== 'removed')
      .map((body) => (body.monsterId === 'reset' ? { ...body, position: { x: 1030, y: floorY } } : body)),
  })
  const move = (position) => position
  h.advance([], { monsters: { move, nextEncounterId: () => 'unexpected' } })
  h.until(4)
  expect(h.advance([], { monsters: { move, nextEncounterId: () => 'unexpected' } })).toEqual([])
  expect(h.monsters.find(({ monsterId }) => monsterId === 'reset').hp).toBe(60)
  expect(h.monsters.some(({ monsterId }) => monsterId === 'removed')).toBe(false)
  expect(h.monsters.find(({ monsterId }) => monsterId === 'still-returning').behavior.kind).toBe('return')
  h.replace({ monsters: h.monsters.filter(({ monsterId }) => monsterId === 'reset') })
  h.until(18)
  h.advance([input(2)])
  expect(h.until(23)).toMatchObject([{ monsterId: 'reset', encounterId: 'encounter-1', attackId: 'swing-2' }])
})

test('replays exact HP, actions, IDs and damage events from the same seed', () => {
  function run() {
    const h = harness({ seed: 1972, monsters: [monster('a', 1035, { target: targetA }), monster('b', 1031)] })
    h.advance([input(1)])
    h.until(25)
    h.advance([input(2, { moveX: 1 })])
    h.until(50)
    return h.trace
  }
  const trace = run()
  expect(trace).toEqual(run())
  expect(trace.flatMap(({ events }) => events).map(({ kind }) => kind)).toContain('playerDamaged')
})

test('starts corpse timing only on a matching receipt and replays a capped set of fresh generations in ID order', () => {
  function replay() {
    let receipt
    const h = harness({
      seed: 1972,
      monsters: [monster('old-a', 1033, { hp: 10 }), monster('old-b', 1035, { hp: 10 })],
      receiptFor: (deathId) => receipt?.get(deathId),
    })
    h.advance([input(1)])
    const events = h.until(5)
    const claims = events.filter(({ kind }) => kind === 'monsterDeathClaimed').map(({ intent }) => intent.claim)
    expect(claims).toHaveLength(2)
    expect(h.monsters.map(({ hp, behavior }) => [hp, behavior.kind])).toEqual([
      [0, 'rewardPending'],
      [0, 'rewardPending'],
    ])
    expect(h.until(25)).toEqual([])
    h.advance([input(2)])
    expect(h.until(30)).toEqual([])
    for (const variant of [{ deathId: 'stale' }, { encounterId: 'stale' }, { generation: 0 }, { monsterId: 'stale' }]) {
      receipt = new Map(claims.map((claim) => [claim.deathId, { ...claim, ...variant }]))
      expect(h.advance()).toEqual([])
      expect(h.monsters.every(({ behavior }) => behavior.kind === 'rewardPending')).toBe(true)
    }
    receipt = new Map(claims.map((claim) => [claim.deathId, claim]))
    const confirmedAt = h.state.tick + 1
    expect(h.advance()).toEqual([])
    expect(h.monsters.every(({ behavior }) => behavior.kind === 'dead' && behavior.startedAt === confirmedAt)).toBe(true)
    h.until(confirmedAt + 29)
    expect(h.monsters.every(({ behavior }) => behavior.kind === 'dead' && behavior.startedAt === confirmedAt)).toBe(true)
    h.advance()
    expect(h.monsters.every(({ behavior }) => behavior.kind === 'respawnWait' && behavior.startedAt === confirmedAt + 30)).toBe(true)
    h.until(confirmedAt + 326)
    h.advance([input(3)])
    h.until(confirmedAt + 329)
    expect(h.monsters.map(({ monsterId, behavior }) => [monsterId, behavior.kind])).toEqual([
      ['old-a', 'respawnWait'],
      ['old-b', 'respawnWait'],
    ])
    expect(h.advance()).toEqual([])
    expect(h.monsters).toHaveLength(2)
    for (const [index, body] of h.monsters.entries()) {
      expect(body).toMatchObject({
        monsterId: `respawned-${index + 1}`,
        generation: 2,
        encounterId: `encounter-${index + 1}`,
        position: body.spawn.origin,
        hp: 60,
        ledger: null,
        behavior: { kind: 'spawning' },
        lastAttackStartedTick: null,
      })
    }
    expect(h.advance()).toEqual([])
    expect(h.monsters.every(({ behavior, hp }) => behavior.kind === 'patrol' && hp === 60)).toBe(true)
    return h.trace
  }
  expect(replay()).toEqual(replay())
})
