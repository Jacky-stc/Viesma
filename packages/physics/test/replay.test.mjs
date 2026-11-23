import { createPhysicsStepper } from '@viesma/physics'
import { createFixedTickDriver } from '@viesma/simulation'
import { expect, test } from 'vitest'
import { balance, body, oneWay, solid, world } from './geometry-fixtures.mjs'

// 每列為 tick、左上角 x/y、vx/vy，以及 grounded。軌跡穿過單向平台、回落、走出平台後落到地板。
const goldenTrace = [
  [1, 4, 62, 120, -540, false],
  [3, 12, 32, 120, -420, false],
  [6, 24, 2, 120, -240, false],
  [10, 24, -10, 0, 0, false],
  [15, 24, 20, 0, 300, false],
  [16, 24, 32, 0, 0, true],
  [24, 56, 32, 120, 0, true],
  [25, 60, 34, 120, 60, false],
  [30, 80, 74, 120, 360, false],
  [31, 84, 80, 120, 0, true],
  [60, 84, 80, 0, 0, true],
]

const voidTrace = [
  [1, 488, 460, 0, 600, false, false],
  [2, 488, 482, 0, 660, false, false],
  [3, 488, 506, 0, 720, false, false],
  [4, 488, 532, 0, 780, false, true],
]

function replay(frameTimes, definition, initial, inputForTick) {
  const step = createPhysicsStepper(definition, balance)
  let elapsedMilliseconds = 0
  let current = initial
  const trace = []
  const driver = createFixedTickDriver({ nowMilliseconds: () => elapsedMilliseconds }, ({ tick, dtSeconds }) => {
    const result = step(current, inputForTick(tick), dtSeconds)
    current = result.body
    const { origin } = current.bounds
    trace.push([tick, origin.x, origin.y, current.velocity.x, current.velocity.y, result.grounded, result.inVoid])
  })
  for (const time of frameTimes) {
    elapsedMilliseconds = time
    while (driver.advance().backlogTicks > 0) {
      // 使用同一個時間樣本補跑積欠的完整 ticks。
    }
  }
  return trace
}

test('replays the golden movement trace at 24, 60 and 144 FPS and after a two-second stall', () => {
  const colliders = [solid(-128, 128, 384, 6), oneWay(20, 80, 40, 1)]
  const inputForTick = (tick) => ({
    horizontalSpeedUnitsPerSecond: tick <= 6 || (tick >= 17 && tick <= 31) ? 120 : 0,
    jumpPressed: tick === 1,
  })
  const baseline = replay([2000], world(...colliders), body(0, 80), inputForTick)
  expect(baseline).toHaveLength(60)
  expect(goldenTrace.map(([tick]) => baseline[tick - 1])).toEqual(goldenTrace.map((row) => [...row, false]))
  for (const fps of [24, 60, 144]) {
    const frameTimes = Array.from({ length: fps * 2 }, (_, index) => ((index + 1) * 1000) / fps)
    expect(replay(frameTimes, world(...colliders.toReversed()), body(0, 80), inputForTick)).toEqual(baseline)
  }
})

test('replays wall sliding and crossing the void plane on the expected tick', () => {
  const input = { horizontalSpeedUnitsPerSecond: 900, jumpPressed: false }
  expect(replay([40, 80, 120, 140], world(), body(480, 440, 540), () => input)).toEqual(voidTrace)
})
