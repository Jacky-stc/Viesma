import { createFixedTickDriver, createSeededRng, step } from '@viesma/simulation'

export function fakeClock(originMilliseconds = 0) {
  let now = originMilliseconds
  return {
    nowMilliseconds: () => now,
    setElapsedMilliseconds: (elapsedMilliseconds) => {
      now = originMilliseconds + elapsedMilliseconds
    },
  }
}

export function replayFoundation(initialState, seed, clockSamples) {
  let state = initialState
  let nextId = 1
  const clock = fakeClock()
  const rng = createSeededRng(seed)
  const ids = { nextAttackId: () => `attack-${nextId++}` }
  const trace = []
  const driver = createFixedTickDriver(
    clock,
    ({ tick, dtSeconds }) => {
      const result = step(state, [], dtSeconds, { tick, rng, ids })
      state = result.state
      trace.push({ ...result, random: rng.nextUnit(), attackId: ids.nextAttackId() })
    },
    state.tick
  )

  for (const elapsed of clockSamples) {
    clock.setElapsedMilliseconds(elapsed)
    while (driver.advance().backlogTicks > 0) {
      // 用同一筆時鐘取樣排空 backlog。
    }
  }
  return trace
}
