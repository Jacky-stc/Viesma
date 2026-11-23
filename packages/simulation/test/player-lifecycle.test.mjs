import { initialPlayerLifecycleBalance } from '@viesma/game-data'
import {
  createFixedTickDriver,
  createPlayer,
  createPlayerController,
  createSafeHubSpawn,
  createSeededRng,
  fixedDeltaSeconds,
  getPlayerPresentationState,
  step,
} from '@viesma/simulation'
import { expect, test } from 'vitest'
import { fakeClock } from './headless.mjs'

const box = (x, y, width, height) => ({ origin: { x, y }, width, height })
const world = {
  bounds: box(0, 0, 400, 240),
  colliders: [{ kind: 'solid', bounds: box(0, 120, 200, 16) }],
}
const hub = {
  mapId: 'fixture',
  spawnId: 'spawn_respawn',
  position: { x: 48, y: 72 },
  safeZone: box(16, 48, 96, 72),
}
const spawn = createSafeHubSpawn(world, hub)
const player = (id = 'beginner') => createPlayer(id, { x: 128, y: 72 }, true)
const full = { hp: 50, maxHp: 50, mp: 30, maxMp: 30 }
const initial = (...players) => ({
  tick: 0,
  map: { mapId: 'fixture', mapInstanceId: 'fixture:1', players, monsters: [], attacks: [] },
})
const effect = (kind, amount, order = 0, characterId = 'beginner') => ({ kind, characterId, order, amount })
const input = (seq, lifeStartedTick = 0) => ({ kind: 'input', characterId: 'beginner', lifeStartedTick, seq, moveX: 1, jumpPressed: true })
const action = (kind, lifeStartedTick = 0) => ({ kind, characterId: 'beginner', lifeStartedTick })

function context() {
  return {
    playerController: createPlayerController(world),
    rng: createSeededRng(7),
    ids: {
      nextAttackId: () => {
        throw new Error('Unexpected attack ID')
      },
    },
    playerRespawn: spawn,
  }
}

function scenario(start = initial(player())) {
  let state = start
  const session = context()
  return ({ effects = [], commands = [], actions = [], destination = spawn } = {}) => {
    const tick = state.tick + 1
    const result = step(state, commands, fixedDeltaSeconds, {
      ...session,
      tick,
      playerRespawn: destination,
      playerVitalEffects: effects.map((effect) => (effect == null ? effect : { tick, lifeStartedTick: 0, ...effect })),
      playerActionEvents: actions,
    })
    state = result.state
    return { player: state.map.players[0], ...result }
  }
}

test('starts a level-one Beginner with the versioned full HP and MP values', () => {
  expect(initialPlayerLifecycleBalance).toMatchObject({ balanceVersion: 'mvp-1', beginnerMaxHp: 50, beginnerMaxMp: 30 })
  expect(player().vitals).toEqual(full)
})

test('clamps resource changes without overflowing and preserves i-frames after same-tick healing', () => {
  const run = scenario()
  const maximum = Number.MAX_SAFE_INTEGER
  expect(run({ effects: [effect('damage', 10), effect('spendMp', 12, 1)] }).player.vitals).toEqual({ ...full, hp: 40, mp: 18 })
  expect(run({ effects: [effect('heal', maximum), effect('spendMp', maximum, 1)] }).player.vitals).toEqual({ ...full, mp: 0 })
  expect(run({ effects: [effect('restoreMp', 15)] }).player.vitals.mp).toBe(15)
  expect(run({ effects: [effect('restoreMp', maximum)] }).player.vitals).toEqual(full)

  const healed = scenario()
  expect(healed({ effects: [effect('damage', 10), effect('heal', 10, 1)] }).player).toMatchObject({
    vitals: full,
    lastHurtTick: 1,
    action: { kind: 'hurt' },
  })
  expect(healed({ effects: [effect('damage', 20)] }).player.vitals).toEqual(full)
})

test('resolves simultaneous damage by authority order, gives each target independent immunity, and accepts damage at tick +30', () => {
  const first = scenario(initial(player('other'), player()))
  const second = scenario(initial(player(), player('other')))
  const effects = [effect('damage', 40, 1), effect('damage', 5), effect('damage', 2, 0, 'other')]
  const impact = first({ effects })
  expect(impact).toEqual(second({ effects: effects.toReversed() }))
  expect(impact.state.map.players.map(({ vitals }) => vitals.hp)).toEqual([45, 48])
  for (let offset = 1; offset < 30; offset++) {
    const { player } = first({ effects: [effect('damage', 50)], actions: [action('attackStarted')] })
    expect(player.vitals.hp).toBe(45)
    expect(player.action.kind).toBe(offset < 6 ? 'hurt' : 'attack')
  }
  const death = first({ effects: [effect('damage', 50)] })
  expect(death.player.vitals.hp).toBe(0)
  expect(death.events).toEqual([expect.objectContaining({ kind: 'playerDied', cause: 'damage', tick: 31 })])
})

test('rejects invalid and out-of-tick effects, conflicting duplicate slots, and forged movement commands', () => {
  const run = scenario()
  const invalid = [undefined, null, NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '15']
  const effects = [
    ...invalid.map((amount, order) => effect('damage', amount, order)),
    effect('restoreMp', 2, -1),
    effect('respawn', 1, 10),
    { ...effect('damage', 50, 11), tick: 0 },
    { ...effect('damage', 50, 12), lifeStartedTick: 1 },
    effect('damage', 50, 13, 'missing'),
    effect('damage', 50, 14),
    effect('damage', 20, 14),
    effect('damage', 50, 14),
    effect('spendMp', 5, 15),
    effect('spendMp', 5, 15),
    null,
  ]
  const first = run({ effects, commands: [effect('damage', 50), { ...input(1), hp: 0 }, { ...input(2), lifeStartedTick: -1 }] })
  expect(first.player).toMatchObject({ vitals: { ...full, mp: 25 }, locomotion: 'idle', action: { kind: 'none' } })
  expect(first.events).toEqual([])
  expect(run({ effects: [{ ...effect('spendMp', 5), tick: 1 }] }).player.vitals.mp).toBe(25)
})

test('emits a single death, ignores damage, heal and attack while dead, and respawns at exactly D + 90', () => {
  const run = scenario()
  run({ commands: [input(1)], effects: [effect('spendMp', 20)], actions: [action('attackStarted')] })
  const death = run({ effects: [effect('damage', 50), effect('heal', 50, 1)], commands: [input(2)] })
  expect(death.player).toMatchObject({
    vitals: { ...full, hp: 0, mp: 10 },
    action: { kind: 'death', diedAtTick: 2 },
    movement: { moveX: 0, lastInputTick: null, jumpBufferTicksRemaining: 0, coyoteTicksRemaining: 0 },
    physics: { velocity: { x: 0, y: 0 } },
  })
  expect(death.events).toEqual([expect.objectContaining({ kind: 'playerDied', tick: 2 })])
  const junk = {
    effects: [effect('damage', 50), effect('heal', 50, 1), effect('restoreMp', 30, 2)],
    actions: [action('attackStarted')],
    commands: [input(1000)],
  }
  for (let offset = 1; offset < 90; offset++) {
    const next = run(junk)
    expect(next.player).toBe(death.player)
    expect(next.events).toEqual([])
  }
  const respawn = run(junk)
  expect(respawn.state.map.players).toHaveLength(1)
  expect(respawn.player).toMatchObject({
    characterId: death.player.characterId,
    position: hub.position,
    vitals: full,
    lifeStartedTick: 92,
    lastHurtTick: null,
    action: { kind: 'none' },
    locomotion: 'idle',
    physics: { grounded: true, inVoid: false, velocity: { x: 0, y: 0 } },
    movement: { moveX: 0, lastProcessedInputSeq: null, lastInputTick: null, jumpBufferTicksRemaining: 0, coyoteTicksRemaining: 0 },
  })
  expect(respawn.events).toEqual([
    {
      kind: 'playerRespawned',
      tick: 92,
      characterId: 'beginner',
      mapId: hub.mapId,
      spawnId: hub.spawnId,
      deathId: death.events[0].deathId,
    },
  ])

  const stale = run(junk)
  expect(stale.events).toEqual([])
  expect(stale.player).toMatchObject({ vitals: full, locomotion: 'idle', action: { kind: 'none' } })
  const fresh = run({ commands: [input(1, 92), input(1000)], actions: [action('attackStarted', 92)] })
  expect(fresh.player).toMatchObject({ locomotion: 'jump', action: { kind: 'attack' }, spawnProtected: false })
  const secondDeath = run({ effects: [{ ...effect('damage', 50), lifeStartedTick: 92 }] })
  expect(secondDeath.events).toEqual([expect.objectContaining({ kind: 'playerDied', tick: 95 })])
  expect(secondDeath.events[0].deathId).not.toBe(death.events[0].deathId)
})

test('respawn protection blocks damage for 90 ticks, even after Hurt would have ended', () => {
  const run = scenario()
  run({ effects: [effect('damage', 50)] })
  for (let tick = 2; tick <= 91; tick++) run()
  const effects = [{ ...effect('damage', 50), lifeStartedTick: 91 }]
  for (let tick = 92; tick < 181; tick++) expect(run({ effects }).player.vitals.hp).toBe(50)
  expect(run({ effects }).player.vitals.hp).toBe(0)
})

test('captures void death once at the physics crossing and drops the falling velocity on respawn', () => {
  const falling = createPlayer('beginner', { x: 300, y: 254 }, false)
  const run = scenario(initial(falling))
  const result = run({ effects: [effect('damage', 1)] })
  expect(result.events).toEqual([expect.objectContaining({ kind: 'playerDied', cause: 'void', tick: 1 })])
  expect(result.player).toMatchObject({ vitals: { hp: 0 }, physics: { inVoid: true, velocity: { x: 0, y: 0 } } })
  for (let tick = 2; tick <= 90; tick++) expect(run().events).toEqual([])
  expect(run().player).toMatchObject({ position: hub.position, physics: { grounded: true, inVoid: false, velocity: { x: 0, y: 0 } } })
})

test.each([
  [{ position: { x: Infinity, y: 72 } }, 'INVALID_VALUE'],
  [{ position: { x: 300, y: 72 } }, 'OUT_OF_RANGE'],
  [{ position: { x: 48, y: 70 } }, 'INVALID_VALUE'],
  [{ position: { x: 48, y: 100 }, safeZone: box(16, 48, 96, 120) }, 'INITIAL_OVERLAP'],
  [{ position: { x: 48.1, y: 72 } }, 'INVALID_GEOMETRY'],
  [{ safeZone: box(-1, 48, 96, 72) }, 'OUT_OF_RANGE'],
  [{ spawnId: '' }, 'INVALID_VALUE'],
])('rejects an unsafe or malformed respawn fixture %j', (overrides, code) => {
  expect(() => createSafeHubSpawn(world, { ...hub, ...overrides })).toThrow(expect.objectContaining({ code }))
})

test('validates support on a one-way platform and does not respawn into an unvalidated or different map', () => {
  expect(
    createSafeHubSpawn({ ...world, colliders: world.colliders.map((collider) => ({ ...collider, kind: 'oneWay' })) }, hub).position
  ).toEqual(hub.position)
  const run = scenario()
  const wrongMap = createSafeHubSpawn(world, { ...hub, mapId: 'elsewhere' })
  const { player: dead } = run({ effects: [effect('damage', 50)] })
  for (let tick = 2; tick <= 91; tick++) expect(run({ destination: wrongMap }).player).toBe(dead)
  expect(run({ destination: hub }).player).toBe(dead)
  expect(run().events).toEqual([expect.objectContaining({ kind: 'playerRespawned', tick: 93 })])
  expect(run().events).toEqual([])
})

test('replays stable deaths and respawns across ordered batches, render rates and scheduler catch-up', () => {
  function replay(fps) {
    const trace = []
    const clock = fakeClock()
    const session = context()
    let state = initial(player('other'), player())
    const driver = createFixedTickDriver(clock, ({ tick, dtSeconds }) => {
      const effects = [effect('damage', 100), effect('damage', 100, 0, 'other')]
      const result = step(state, [], dtSeconds, {
        ...session,
        tick,
        playerVitalEffects:
          tick === 1 ? (fps ? effects : effects.toReversed()).map((effect) => ({ tick, lifeStartedTick: 0, ...effect })) : [],
      })
      state = result.state
      trace.push({ events: result.events, states: state.map.players.map(getPlayerPresentationState) })
    })
    const frameCount = fps ? fps * 4 : 1
    for (let i = 1; i <= frameCount; i++) {
      clock.setElapsedMilliseconds((i * 4000) / frameCount)
      while (driver.advance().backlogTicks > 0) {
        // 以固定 delta 逐 tick 補跑。
      }
    }
    return trace
  }
  const trace = replay()
  expect(trace).toHaveLength(120)
  expect(trace[0].events.map(({ kind, characterId }) => [kind, characterId])).toEqual([
    ['playerDied', 'beginner'],
    ['playerDied', 'other'],
  ])
  expect(trace[90].events.map(({ kind, characterId }) => [kind, characterId])).toEqual([
    ['playerRespawned', 'beginner'],
    ['playerRespawned', 'other'],
  ])
  for (const fps of [24, 60, 144]) expect(replay(fps)).toEqual(trace)
})
