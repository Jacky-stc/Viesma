import { toSimulationTick } from '@viesma/domain'
import { initialPhysicsBalance } from '@viesma/game-data'
import { createPlayer, findOverlappingPortal, ticksPerSecond } from '@viesma/simulation'
import { describe, expect, it, vi } from 'vitest'
import { createInputState } from '../src/input/input-state'
import { createPlayground } from '../src/playground/scene'
import { followCamera } from '../src/rendering/camera'
import { facingScale, interpolatePlayer, projectPlayer } from '../src/rendering/player-view'

const fullVitals = { hp: 50, maxHp: 50, mp: 30, maxMp: 30 }

describe('snapshot mapping', () => {
  it.each([
    ['idle', { kind: 'none' }, 'idle', 'right'],
    ['run', { kind: 'none' }, 'run', 'right'],
    ['jump', { kind: 'none' }, 'jump', 'right'],
    ['fall', { kind: 'none' }, 'fall', 'right'],
    ['jump', { kind: 'attack', facing: 'left' }, 'attack', 'left'],
    ['fall', { kind: 'hurt', ticksRemaining: 2 }, 'hurt', 'right'],
    ['run', { kind: 'death', diedAtTick: 12 }, 'death', 'right'],
  ])('projects %s with action %j as %s', (locomotion, action, state, facing) => {
    const position = Object.freeze({ x: 28, y: 42 })
    const player = Object.freeze({ ...createPlayer('p', position, true), locomotion, action: Object.freeze(action), position })
    const snapshot = projectPlayer(player, toSimulationTick(12))
    expect(snapshot).toEqual({ tick: 12, position, state, facing, vitals: fullVitals })
    expect(snapshot.position).not.toBe(player.position)
    expect(facingScale[snapshot.facing]).toBe(facing === 'left' ? -1 : 1)
  })

  it('samples within the supplied snapshots and switches discrete fields at the boundary', () => {
    const previous = Object.freeze({
      tick: 3,
      position: Object.freeze({ x: 10, y: 20 }),
      state: 'jump',
      facing: 'right',
      vitals: fullVitals,
    })
    const current = Object.freeze({
      tick: 4,
      position: Object.freeze({ x: 18, y: 14 }),
      state: 'attack',
      facing: 'left',
      vitals: { ...fullVitals, mp: 25 },
    })
    expect(interpolatePlayer(previous, current, -0.5)).toEqual({
      position: previous.position,
      state: 'jump',
      facing: 'right',
      vitals: previous.vitals,
      visualTick: 3,
    })
    expect(interpolatePlayer(previous, current, 0.25)).toEqual({
      position: { x: 12, y: 18.5 },
      state: 'jump',
      facing: 'right',
      vitals: previous.vitals,
      visualTick: 3.25,
    })
    expect(interpolatePlayer(previous, current, 1.5)).toEqual({
      position: current.position,
      state: 'attack',
      facing: 'left',
      vitals: current.vitals,
      visualTick: 4,
    })
  })
})

describe('fixed-tick playground', () => {
  it('runs all seven presentation states and lands on the actual one-way and solid colliders', () => {
    const scene = createPlayground(0)
    const frames = Array.from({ length: 268 }, (_, index) => scene.advance(((index + 0.5) * 1000) / ticksPerSecond))
    expect(new Set(frames.map(({ state }) => state))).toEqual(new Set(['idle', 'run', 'jump', 'fall', 'attack', 'hurt', 'death']))
    expect(frames.find(({ state }) => state === 'attack')?.facing).toBe('left')
    for (const [mapId, colliderId] of [
      ['village', 'village_walkway'],
      ['m1', 'forest_ledge'],
    ]) {
      const { bounds } = frames.find(({ map }) => map.id === mapId).map.colliders.find(({ id }) => id === colliderId)
      const onPlatform = frames.some(
        ({ map, position }) =>
          map.id === mapId &&
          position.x >= bounds.origin.x &&
          position.x < bounds.origin.x + bounds.width &&
          position.y + initialPhysicsBalance.bodyHeightWorldUnits === bounds.origin.y
      )
      expect(onPlatform).toBe(true)
    }
  })

  it('produces the same fixed-time samples from 24, 60 or 144 render frames per second', () => {
    function sample(fps) {
      const start = 7000
      const scene = createPlayground(start)
      return Array.from({ length: 9 }, (_, second) => {
        for (let frame = 1; frame < fps; frame++) {
          scene.advance(start + second * 1000 + (frame * 1000) / fps)
        }
        return scene.advance(start + (second + 1) * 1000)
      })
    }
    expect(sample(24)).toEqual(sample(60))
    expect(sample(144)).toEqual(sample(60))
  })

  it('holds the latest completed tick when backlogged and recovers without changing fixed samples', () => {
    const scene = createPlayground(0)
    const baseline = createPlayground(0)
    const delayed = scene.advance(2000)
    expect(delayed.visualTick).toBe(5)
    for (let i = 0; i < 10; i++) scene.advance(2000)
    const caughtUp = scene.advance(2000)
    for (let i = 1; i <= 60; i++) baseline.advance((i * 1000) / ticksPerSecond)
    expect(caughtUp).toEqual(baseline.advance(2000))
  })

  it('projects the destination spawn immediately and follows with destination bounds', () => {
    const scene = createPlayground(0)
    const frame = (tick) => scene.advance((tick * 1000) / ticksPerSecond)
    for (let tick = 1; tick < 71; tick++) frame(tick)
    const source = frame(71)
    const destination = frame(72)
    expect(source.map.id).toBe('village')
    expect(destination.map.id).toBe('m1')
    expect(destination.position).toEqual(destination.map.spawns.find(({ id }) => id === 'spawn_from_village').position)
    const viewport = { width: 1280, height: 720 }
    expect(followCamera(source.position, source.map.bounds, viewport).origin.x).toBeGreaterThan(0)
    expect(followCamera(destination.position, destination.map.bounds, viewport).origin.x).toBe(0)
    for (let tick = 73; tick < 133; tick++) frame(tick)
    const moved = frame(133)
    expect(followCamera(moved.position, moved.map.bounds, viewport).origin.x).toBeGreaterThan(0)
  })

  it('respawns after exactly 90 ticks without interpolating across the world', () => {
    const scene = createPlayground(0)
    const initial = scene.advance(0)
    for (let i = 1; i < 315; i++) scene.advance((i * 1000) / ticksPerSecond)
    const end = scene.advance(10499)
    expect(end).toMatchObject({ state: 'death', vitals: { hp: 0 } })
    expect(end.position).not.toEqual(initial.position)
    const restart = scene.advance(10500)
    expect(restart).toMatchObject({ state: 'idle', facing: 'right', position: initial.position, vitals: fullVitals })
    for (let i = 316; i <= 420; i++) scene.advance((i * 1000) / ticksPerSecond)
    expect(scene.advance(14001).state).toBe('run')
  })

  it('samples input once per fixed tick, including catch-up and neutral frames', () => {
    function run(renderBetweenTicks) {
      const input = createInputState()
      const sample = vi.fn(input.sample)
      const publishActions = vi.fn()
      const scene = createPlayground(0, { sample, clear: input.clear, publishActions })
      const spawn = scene.advance(0)
      input.press('KeyA', 'left')
      input.press(2, 'jump')
      input.release(2)
      input.press('KeyE', 'interact')
      if (renderBetweenTicks) scene.advance(32)
      expect(sample).not.toHaveBeenCalled()
      expect(publishActions).not.toHaveBeenCalled()
      const first = scene.advance(34)
      expect(sample).toHaveBeenCalledTimes(1)
      expect(publishActions).toHaveBeenCalledExactlyOnceWith(['interact'])
      expect(first.position.y).toBeLessThan(spawn.position.y)
      input.press('KeyD', 'right')
      if (renderBetweenTicks) scene.advance(90)
      const neutral = scene.advance(101)
      expect(neutral.facing).toBe('left')
      expect(sample.mock.results.map(({ value }) => value.moveX)).toEqual([-1, 0, 0])
      expect(sample.mock.results.map(({ value }) => value.jumpPressed)).toEqual([true, false, false])
      return neutral
    }

    expect(run(true)).toEqual(run(false))
  })

  it('protects Village and routes debug damage in M1 through the simulation lifecycle', () => {
    let damage = 'damage'
    const input = createInputState()
    const clear = vi.fn(input.clear)
    const publishActions = vi.fn()
    const scene = createPlayground(0, {
      sample: input.sample,
      clear,
      publishActions,
      takeDebugDamage() {
        const pending = damage
        damage = undefined
        return pending
      },
    })
    const spawn = scene.advance(0)
    let tick = 0
    const frame = () => scene.advance((++tick * 1000) / ticksPerSecond)
    input.press('KeyD', 'right')
    expect(frame().vitals.hp).toBe(50)
    let current
    do {
      current = frame()
    } while (!findOverlappingPortal(current.map, current.position) && tick < 100)
    input.release('KeyD')
    input.press('ArrowUp', 'up')
    expect(frame().map.id).toBe('m1')
    input.press('KeyW', 'up')
    expect(input.sample().portalPressed).toBe(false)
    input.release('ArrowUp')
    input.release('KeyW')
    const entryTick = tick
    while (tick < entryTick + 89) frame()
    damage = 'damage'
    frame()
    const hurtTick = tick
    expect(frame()).toMatchObject({ state: 'hurt', vitals: { hp: 40 } })
    while (tick < hurtTick + 29) frame()
    damage = 'lethal'
    frame()
    const deathTick = tick
    expect(frame()).toMatchObject({ state: 'death', vitals: { hp: 0 } })
    expect(clear).toHaveBeenCalledTimes(1)
    while (tick < deathTick + 89) frame()
    input.press('ArrowRight', 'right')
    input.press('Space', 'jump')
    input.press('KeyJ', 'attack')
    input.press('KeyE', 'interact')
    expect(frame()).toMatchObject({ state: 'idle', map: { id: 'village' }, position: spawn.position, vitals: fullVitals })
    expect(clear).toHaveBeenCalledTimes(2)
    frame()
    expect(frame()).toMatchObject({ state: 'idle', position: spawn.position })
    expect(publishActions.mock.calls).toEqual([[[]], [[]], [[]]])
  })
})
