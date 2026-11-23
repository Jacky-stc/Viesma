import { toSimulationTick } from '@viesma/domain'
import { initialPhysicsBalance } from '@viesma/game-data'
import {
  createFixedTickDriver,
  createPlayer,
  createPlayerController,
  createSeededRng,
  fixedDeltaSeconds,
  getPlayerPresentationState,
  normalizeMovementInput,
  step,
} from '@viesma/simulation'
import { expect, test, vi } from 'vitest'
import { fakeClock } from './headless.mjs'

const box = (x, y, width, height) => ({ origin: { x, y }, width, height })
const floor = { kind: 'solid', bounds: box(-256, 128, 768, 16) }
const world = { bounds: box(-256, -256, 768, 768), colliders: [floor] }
const edgeWorld = {
  ...world,
  colliders: [
    { kind: 'oneWay', bounds: box(-48, 128, 49, 1) },
    { kind: 'solid', bounds: box(-256, 384, 768, 16) },
  ],
}
const spawn = (id = 'player') => createPlayer(id, { x: 0, y: 80 }, true)
const input = (seq, moveX = 0, jumpPressed = false, characterId = 'player') => ({
  kind: 'input',
  characterId,
  lifeStartedTick: 0,
  seq,
  moveX,
  jumpPressed,
})
const action = (kind, characterId = 'player') => ({ kind, characterId, lifeStartedTick: 0 })
const damage = (tick, amount) => ({ ...action('damage'), tick, amount, order: 0 })

function initialState(...players) {
  return { tick: toSimulationTick(0), map: { mapId: 'm1', mapInstanceId: 'm1:1', players, monsters: [], attacks: [] } }
}

function tickContext(playerController) {
  return { rng: createSeededRng(17), ids: { nextAttackId: () => 'attack-1' }, playerController }
}

function scenario(player = spawn(), definition = world) {
  let state = initialState(player)
  const context = tickContext(createPlayerController(definition))
  return (commands = [], playerActionEvents = [], playerVitalEffects = []) => {
    state = step(state, commands, fixedDeltaSeconds, {
      ...context,
      tick: toSimulationTick(state.tick + 1),
      playerActionEvents,
      playerVitalEffects,
    }).state
    return state.map.players[0]
  }
}

test('accelerates Idle → Run, caps run speed and decelerates Run → Idle on release', () => {
  const player = spawn()
  const runTick = scenario(player)
  expect(getPlayerPresentationState(player)).toBe('idle')
  const first = runTick([input(0, 1)])
  expect(first).toMatchObject({ locomotion: 'run', position: { x: 2, y: 80 }, physics: { grounded: true, velocity: { x: 60, y: 0 } } })
  expect(runTick().physics.velocity.x).toBe(120)
  expect(runTick().physics.velocity.x).toBe(180)
  expect(runTick().physics.velocity.x).toBe(initialPhysicsBalance.runSpeedUnitsPerSecond)
  const braking = runTick([input(1)])
  expect(braking.locomotion).toBe('run')
  expect(braking.physics.velocity.x).toBeCloseTo(220 - 2200 / 30)
  expect(runTick().locomotion).toBe('run')
  expect(runTick()).toMatchObject({ locomotion: 'idle', physics: { velocity: { x: 0, y: 0 } } })
  expect(player).toEqual(spawn())
})

test('normalizes directional buttons and only changes facing for a nonneutral input', () => {
  const normalized = (left, right) => normalizeMovementInput({ left, right, jump: false }, false)
  expect(normalized(false, false).moveX).toBe(0)
  expect(normalized(true, false).moveX).toBe(-1)
  expect(normalized(false, true).moveX).toBe(1)
  const conflict = normalized(true, true)
  expect(conflict.moveX).toBe(0)
  const runTick = scenario()
  expect(runTick([{ ...input(0), ...normalized(true, false) }])).toMatchObject({ facing: 'left', physics: { velocity: { x: -60 } } })
  expect(runTick([{ ...input(1), ...conflict }])).toMatchObject({ facing: 'left', locomotion: 'idle', movement: { moveX: 0 } })
  expect(runTick([{ ...input(2), ...normalized(false, true) }])).toMatchObject({ facing: 'right', physics: { velocity: { x: 60 } } })
})

test('one press jumps once, held input never retriggers on landing, and release permits a new press', () => {
  const runTick = scenario()
  const trace = Array.from({ length: 25 }, (_, seq) => {
    const movement = normalizeMovementInput({ left: false, right: false, jump: true }, seq > 0)
    return runTick([{ ...input(seq), ...movement }])
  })
  expect(trace[0]).toMatchObject({ locomotion: 'jump', position: { x: 0, y: 62 }, physics: { velocity: { x: 0, y: -540 } } })
  expect(trace[9]).toMatchObject({ locomotion: 'fall', position: { y: -10 }, physics: { grounded: false, velocity: { y: 0 } } })
  expect(trace[18]).toMatchObject({ locomotion: 'idle', position: { y: 80 }, physics: { grounded: true } })
  expect(trace.slice(19).map((player) => player.locomotion)).toEqual(Array(6).fill('idle'))
  const release = normalizeMovementInput({ left: false, right: false, jump: false }, true)
  expect(runTick([{ ...input(25), ...release }]).locomotion).toBe('idle')
  expect(runTick([input(26, 0, true)]).locomotion).toBe('jump')
})

test('an early airborne jump press cannot change the arc or start a second jump when the buffer expires', () => {
  const baseline = scenario()
  const extraPress = scenario()
  for (let seq = 0; seq < 22; seq++) {
    const expected = baseline([input(seq, 0, seq === 0)])
    const actual = extraPress([input(seq, 0, seq === 0 || seq === 2)])
    expect(actual.physics).toEqual(expected.physics)
    expect(actual.position).toEqual(expected.position)
    if (seq === 2) expect(actual.movement.jumpBufferTicksRemaining).toBe(initialPhysicsBalance.jumpBufferTicks)
  }
  expect(extraPress().locomotion).toBe('idle')
})

test('supports air steering and neutral inertia, then lands in Run while still moving', () => {
  const runTick = scenario()
  runTick([input(0, 1, true)])
  expect(runTick([input(1, 1)]).physics.velocity.x).toBe(120)
  expect(runTick([input(2)]).physics.velocity.x).toBe(120)
  expect(runTick([input(3, -1)])).toMatchObject({ facing: 'left', physics: { velocity: { x: 60 } } })
  for (let seq = 4; seq < 18; seq++) runTick([input(seq, -1)])
  expect(runTick([input(18, -1)])).toMatchObject({ locomotion: 'run', facing: 'left', physics: { grounded: true } })
})

test.each([
  [2, 'jump'],
  [1, 'idle'],
])('a press on tick %i before landing on tick 4 leads to %s on tick 5', (pressTick, expected) => {
  const runTick = scenario(createPlayer('player', { x: 0, y: 60 }, false))
  const trace = Array.from({ length: 6 }, (_, index) => {
    const tick = index + 1
    return runTick([input(index, 0, tick === pressTick)])
  })
  expect(trace[2].locomotion).toBe('fall')
  expect(trace[3].locomotion).toBe('idle')
  expect(trace[4].locomotion).toBe(expected)
  expect(trace[4].movement.jumpBufferTicksRemaining).toBe(0)
})

test.each([
  [1, 'jump'],
  [3, 'jump'],
  [4, 'fall'],
])('walking off a platform allows a coyote jump on offset %i only inside the window', (offset, expected) => {
  const runTick = scenario(spawn(), edgeWorld)
  expect(runTick([input(0, 1)])).toMatchObject({
    locomotion: 'fall',
    position: { x: 2, y: 82 },
    movement: { coyoteTicksRemaining: initialPhysicsBalance.coyoteTimeTicks },
    physics: { grounded: false, velocity: { y: 60 } },
  })
  for (let wait = 1; wait < offset; wait++) expect(runTick().locomotion).toBe('fall')
  expect(runTick([input(1, 0, true)])).toMatchObject({ locomotion: expected, movement: { coyoteTicksRemaining: 0 } })
  expect(runTick([input(2, 0, true)]).physics.velocity.y).toBe(expected === 'jump' ? -480 : 360)
})

test('a jump on the last supported tick uses ground contact and grants no coyote jump', () => {
  const runTick = scenario(spawn(), edgeWorld)
  expect(runTick([input(0, 1, true)])).toMatchObject({
    locomotion: 'jump',
    movement: { coyoteTicksRemaining: 0 },
    position: { x: 2, y: 62 },
  })
  expect(runTick([input(1, 0, true)]).physics.velocity.y).toBe(-480)
})

test('airborne Attack keeps the same trajectory and locks facing without allowing an overlapping Attack', () => {
  const baseline = scenario()
  const attack = scenario()
  for (let seq = 0; seq < 20; seq++) {
    const frames = [input(seq, seq < 2 ? 1 : -1, seq === 0)]
    const expected = baseline(frames)
    const events = seq === 0 || seq === 3 ? [action('attackStarted')] : seq === 19 ? [action('attackEnded')] : []
    const actual = attack(frames, events)
    expect(actual.physics).toEqual(expected.physics)
    expect(actual.position).toEqual(expected.position)
    expect(actual.locomotion).toBe(expected.locomotion)
    if (seq < 19) {
      expect(getPlayerPresentationState(actual)).toBe('attack')
      expect(actual.action.facing).toBe('right')
      expect(actual.facing).toBe(seq < 2 ? 'right' : 'left')
    } else {
      expect(getPlayerPresentationState(actual)).toBe('run')
    }
  }
})

test('Hurt interrupts Attack and blocks jump edges and new Attack for six ticks', () => {
  const runTick = scenario()
  expect(getPlayerPresentationState(runTick([], [action('attackStarted')]))).toBe('attack')
  for (let offset = 0; offset < initialPhysicsBalance.hurtTicks; offset++) {
    const effects = offset === 0 ? [damage(2, 1)] : []
    expect(runTick([input(offset, 1, true)], [action('attackStarted')], effects)).toMatchObject({
      action: { kind: 'hurt', ticksRemaining: 6 - offset },
      locomotion: 'run',
      physics: { grounded: true },
      movement: { jumpBufferTicksRemaining: 0 },
    })
  }
  const recovered = runTick([input(6)])
  expect(recovered.action.kind).toBe('none')
  expect(recovered.physics.grounded).toBe(true)
  expect(runTick([input(7, 0, true)]).locomotion).toBe('jump')
})

test('lethal damage wins simultaneous action events and freezes the body before accepting any new movement', () => {
  const runTick = scenario()
  runTick([input(0, 1, true)], [action('attackStarted')])
  const jumping = runTick([input(1, 1, true)])
  expect(jumping.movement.jumpBufferTicksRemaining).toBe(3)
  const dead = runTick([input(2, -1, true)], [action('attackEnded'), action('attackStarted')], [damage(3, 50)])
  expect(getPlayerPresentationState(dead)).toBe('death')
  expect(dead).toMatchObject({
    position: jumping.position,
    facing: 'right',
    physics: { velocity: { x: 0, y: 0 } },
    movement: { moveX: 0, lastProcessedInputSeq: 1, lastInputTick: null, coyoteTicksRemaining: 0, jumpBufferTicksRemaining: 0 },
  })
  expect(runTick([input(3, -1)], [action('attackStarted')])).toBe(dead)
})

test('void contact immediately freezes the body in Death', () => {
  const runTick = scenario(createPlayer('player', { x: 0, y: 526 }, false))
  const fallen = runTick([input(0)])
  expect(fallen).toMatchObject({ position: { y: 528 }, physics: { inVoid: true } })
  expect(getPlayerPresentationState(fallen)).toBe('death')
  expect(runTick([input(1, 1)])).toBe(fallen)
})

test('ignores malformed, forged and stale frames and neutralizes intent after six missing ticks', () => {
  const baseline = scenario()
  const runTick = scenario()
  const frames = [input(3, 1)]
  expect(runTick(frames)).toEqual(baseline(frames))
  const invalid = [
    null,
    { kind: 'input' },
    input(2, -1, true),
    input(3, -1, true),
    input(4, -1, true, 'unknown'),
    input(-1, -1, true),
    input(3.5, -1, true),
    input(Number.MAX_SAFE_INTEGER + 1, -1, true),
    input(Infinity, -1, true),
    input('4', -1, true),
    input(4, 2, true),
    input(4, 0, 1),
    { ...input(4), position: { x: 0, y: 0 }, velocity: { x: 1000, y: 0 } },
    { ...input(4), attackStarted: true },
    action('death'),
  ]
  for (let gap = 1; gap <= 6; gap++) {
    const player = runTick(invalid)
    expect(player).toEqual(baseline())
    expect(player.movement).toMatchObject({ lastProcessedInputSeq: 3, lastInputTick: 1, moveX: gap < 6 ? 1 : 0 })
  }
  expect(runTick([input(4, -1)]).movement).toMatchObject({ lastProcessedInputSeq: 4, lastInputTick: 8, moveX: -1 })
})

test('processes one frame and one controller step per player in stable ID order, independent of batch order', () => {
  const players = [spawn('b'), spawn('a'), spawn('c')].map(Object.freeze)
  const state = initialState(...players)
  Object.freeze(state.map.players)
  const controller = vi.fn(createPlayerController(world))
  const context = { ...tickContext(controller), tick: toSimulationTick(1) }
  const commands = [
    input(1, -1, true, 'b'),
    input(2, 1, false, 'b'),
    input(5, 1, true, 'a'),
    input(3, 1, false, 'a'),
    input(5, -1, false, 'a'),
    input(2, 1, false, 'b'),
    input(-0, -0, false, 'c'),
    input(0, 0, false, 'c'),
  ].map(Object.freeze)
  const result = step(state, Object.freeze(commands), fixedDeltaSeconds, context)
  expect(controller.mock.calls.map(([player]) => player.characterId)).toEqual(['a', 'b', 'c'])
  expect(result.state.map.players).toMatchObject([
    { characterId: 'a', locomotion: 'idle', movement: { lastProcessedInputSeq: null } },
    { characterId: 'b', locomotion: 'run', position: { x: 2, y: 80 }, movement: { lastProcessedInputSeq: 2 } },
    { characterId: 'c', locomotion: 'idle', movement: { lastProcessedInputSeq: 0, moveX: 0 } },
  ])
  const reversed = step(initialState(...players.toReversed()), commands.toReversed(), fixedDeltaSeconds, context)
  expect(reversed).toEqual(result)
  expect(result.state.tick).toBe(1)
  expect(result.events).toEqual([])
})

test('replays the same movement, state transitions and commands across 24, 60 and 144 FPS and catch-up', () => {
  function replay(frameTimes) {
    const clock = fakeClock()
    const context = tickContext(createPlayerController(edgeWorld))
    let state = initialState(spawn())
    const trace = []
    const driver = createFixedTickDriver(clock, ({ tick, dtSeconds }) => {
      const commands = [input(tick, tick < 10 ? 1 : tick < 20 ? -1 : 0, tick === 4)]
      const playerActionEvents = tick === 5 ? [action('attackStarted')] : []
      const playerVitalEffects = tick === 10 ? [damage(tick, 1)] : []
      const result = step(state, commands, dtSeconds, { ...context, tick, playerActionEvents, playerVitalEffects })
      state = result.state
      trace.push(result)
    })
    for (const time of frameTimes) {
      clock.setElapsedMilliseconds(time)
      while (driver.advance().backlogTicks > 0) {
        // 使用同一個取樣補跑完整 ticks。
      }
    }
    return trace
  }

  const trace = replay([2000])
  expect(trace).toHaveLength(60)
  const states = trace.map(({ state }) => getPlayerPresentationState(state.map.players[0]))
  expect(states).toEqual(expect.arrayContaining(['fall', 'jump', 'attack', 'hurt', 'idle']))
  for (const fps of [24, 60, 144]) {
    expect(replay(Array.from({ length: fps * 2 }, (_, index) => ((index + 1) * 1000) / fps))).toEqual(trace)
  }
})
