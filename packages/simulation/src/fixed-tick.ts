import { toSimulationTick, type SimulationTick } from '@viesma/domain'

export const ticksPerSecond = 30
export const fixedDeltaSeconds = 1 / ticksPerSecond
export const maxCatchUpTicks = 5

export interface MonotonicClock {
  nowMilliseconds(): number
}

export interface FixedTick {
  readonly tick: SimulationTick
  readonly dtSeconds: number
}

export interface FixedTickAdvance {
  readonly tick: SimulationTick
  readonly steps: number
  readonly backlogTicks: number
}

export interface FixedTickDriver {
  advance(): FixedTickAdvance
}

export function createFixedTickDriver(
  clock: MonotonicClock,
  onTick: (step: FixedTick) => undefined,
  initialTick: SimulationTick = toSimulationTick(0)
): FixedTickDriver {
  const startMilliseconds = clock.nowMilliseconds()
  if (!Number.isFinite(startMilliseconds)) {
    throw new RangeError('Clock sample must be finite')
  }

  let previousMilliseconds = startMilliseconds
  let tick = toSimulationTick(initialTick)
  let advancing = false

  return {
    advance() {
      if (advancing) {
        throw new Error('Fixed tick driver cannot advance during a tick callback')
      }

      advancing = true
      try {
        const nowMilliseconds = clock.nowMilliseconds()
        if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < previousMilliseconds) {
          throw new RangeError('Clock sample must be finite and monotonic')
        }

        // 從同一時間原點計算到期 tick，保留小數時間，避免逐步扣除 dt 造成累積誤差。
        let elapsedTicks = Math.floor(((nowMilliseconds - startMilliseconds) * ticksPerSecond) / 1000)
        // 換算 ticks 時的浮點誤差可能跨過整數邊界，直接比較相鄰的到期時間。
        if (nowMilliseconds >= startMilliseconds + ((elapsedTicks + 1) * 1000) / ticksPerSecond) {
          elapsedTicks += 1
        } else if (nowMilliseconds < startMilliseconds + (elapsedTicks * 1000) / ticksPerSecond) {
          elapsedTicks -= 1
        }
        const targetTick = toSimulationTick(initialTick + elapsedTicks)
        previousMilliseconds = nowMilliseconds

        const steps = Math.min(targetTick - tick, maxCatchUpTicks)
        for (let index = 0; index < steps; index++) {
          const nextTick = toSimulationTick(tick + 1)
          onTick({ tick: nextTick, dtSeconds: fixedDeltaSeconds })
          tick = nextTick
        }

        return { tick, steps, backlogTicks: targetTick - tick }
      } finally {
        advancing = false
      }
    },
  }
}
