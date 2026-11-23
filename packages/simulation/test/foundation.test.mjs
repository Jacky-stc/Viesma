import { toSimulationTick } from '@viesma/domain'
import { createFixedTickDriver, createSeededRng, step } from '@viesma/simulation'
import { expect, test } from 'vitest'
import { fakeClock, replayFoundation } from './headless.mjs'

test('advances exactly 30 ticks in one second and carries fractional elapsed time', () => {
  const clock = fakeClock(500)
  const ticks = []
  const driver = createFixedTickDriver(clock, ({ tick }) => ticks.push(tick))

  clock.setElapsedMilliseconds(33)
  expect(driver.advance()).toEqual({ tick: 0, steps: 0, backlogTicks: 0 })
  clock.setElapsedMilliseconds(34)
  expect(driver.advance()).toEqual({ tick: 1, steps: 1, backlogTicks: 0 })

  for (let elapsed = 40; elapsed <= 1000; elapsed += 10) {
    clock.setElapsedMilliseconds(elapsed)
    driver.advance()
  }
  expect(ticks).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))
})

test('advances on fractional clock deadlines without missing or anticipating a tick', () => {
  const clock = fakeClock(500)
  const driver = createFixedTickDriver(clock, () => {})
  for (let tick = 1; tick <= 180; tick++) {
    const deadline = (tick * 1000) / 30
    clock.setElapsedMilliseconds(deadline - 0.0001)
    expect(driver.advance().steps).toBe(0)
    clock.setElapsedMilliseconds(deadline)
    expect(driver.advance()).toEqual({ tick, steps: 1, backlogTicks: 0 })
  }
})

test('limits each catch-up to five ticks, retaining backlog and the fixed delta', () => {
  const clock = fakeClock()
  const deltas = []
  const driver = createFixedTickDriver(clock, ({ dtSeconds }) => deltas.push(dtSeconds), toSimulationTick(40))
  clock.setElapsedMilliseconds(1000)

  for (let batch = 1; batch <= 6; batch++) {
    expect(driver.advance()).toEqual({ tick: 40 + batch * 5, steps: 5, backlogTicks: 30 - batch * 5 })
  }
  expect(driver.advance()).toEqual({ tick: 70, steps: 0, backlogTicks: 0 })
  expect(deltas).toEqual(Array(30).fill(1 / 30))
})

test('replays the same tick, RNG and injected ID sequence across clock sampling schedules', () => {
  const initial = Object.freeze({
    tick: toSimulationTick(0),
    map: Object.freeze({ mapId: 'm1', mapInstanceId: 'm1:1', players: [], monsters: [], attacks: [] }),
  })

  const trace = replayFoundation(initial, 1234, [50, 98, 150, 400, 730, 1000])
  expect(trace).toHaveLength(30)
  expect(trace).toEqual(replayFoundation(initial, 1234, [1000]))
  expect(trace.map(({ random }) => random)).not.toEqual(replayFoundation(initial, 1235, [1000]).map(({ random }) => random))
  for (const [index, { state, events, attackId }] of trace.entries()) {
    expect(state.tick).toBe(index + 1)
    expect(state.map).toBe(initial.map)
    expect(events).toEqual([])
    expect(attackId).toBe(`attack-${index + 1}`)
  }
  expect(initial.tick).toBe(0)
})

test('rejects reentrant advance without consuming the pending tick', () => {
  const clock = fakeClock()
  const ticks = []
  const driver = createFixedTickDriver(clock, ({ tick }) => {
    expect(() => driver.advance()).toThrow(/during a tick callback/)
    ticks.push(tick)
  })
  clock.setElapsedMilliseconds(100)
  expect(driver.advance()).toEqual({ tick: 3, steps: 3, backlogTicks: 0 })
  expect(ticks).toEqual([1, 2, 3])
})

test('keeps seeded RNG instances independent and rejects invalid seeds', () => {
  const seed = 0xffffffff
  const first = createSeededRng(seed)
  const second = createSeededRng(seed)
  const samples = Array.from({ length: 8 }, () => first.nextUnit())

  expect(Array.from({ length: 8 }, () => second.nextUnit())).toEqual(samples)
  for (const sample of samples) {
    expect(sample).toBeGreaterThanOrEqual(0)
    expect(sample).toBeLessThan(1)
  }
  for (const invalidSeed of [-1, 0.5, 0x1_0000_0000, NaN]) {
    expect(() => createSeededRng(invalidSeed)).toThrow(/unsigned 32-bit integer/)
  }
})

test('rejects invalid clocks, variable dt and skipped ticks', () => {
  const clock = fakeClock()
  const driver = createFixedTickDriver(clock, () => {})
  clock.setElapsedMilliseconds(100)
  expect(driver.advance().tick).toBe(3)
  clock.setElapsedMilliseconds(99)
  expect(() => driver.advance()).toThrow(/monotonic/)
  clock.setElapsedMilliseconds(200)
  expect(driver.advance().tick).toBe(6)
  expect(() => createFixedTickDriver({ nowMilliseconds: () => Infinity }, () => {})).toThrow(/finite/)

  const state = { tick: toSimulationTick(0), map: { mapId: 'm1', mapInstanceId: 'm1:1', players: [], monsters: [], attacks: [] } }
  const context = { tick: toSimulationTick(1), rng: createSeededRng(0), ids: { nextAttackId: () => 'attack-1' } }
  expect(() => step(state, [], 1 / 15, context)).toThrow(/fixed delta/)
  expect(() => step(state, [], 1 / 30, { ...context, tick: toSimulationTick(2) })).toThrow(/next tick/)
  expect(() => step(state, [{ kind: 'input' }], 1 / 30, context)).toThrow(/does not accept commands/)
})
