import { toSimulationTick, type AttackId, type MapState, type SimulationTick } from '@viesma/domain'
import { fixedDeltaSeconds } from './fixed-tick.js'
import type { RandomSource } from './random.js'

export interface SimulationState {
  readonly tick: SimulationTick
  readonly map: MapState
}

export type SimulationCommand = never
export type SimulationEvent = never

export interface SimulationIdSource {
  nextAttackId(): AttackId
}

export interface SimulationContext {
  readonly tick: SimulationTick
  readonly rng: RandomSource
  readonly ids: SimulationIdSource
}

export interface SimulationStepResult {
  readonly state: SimulationState
  readonly events: readonly SimulationEvent[]
}

export function step(
  state: SimulationState,
  commands: readonly SimulationCommand[],
  dtSeconds: number,
  context: SimulationContext
): SimulationStepResult {
  if (dtSeconds !== fixedDeltaSeconds || context.tick !== toSimulationTick(state.tick + 1)) {
    throw new RangeError('Simulation step requires one fixed delta and the next tick')
  }
  if (commands.length > 0) {
    throw new RangeError('Simulation does not accept commands yet')
  }

  return { state: { ...state, tick: context.tick }, events: [] }
}
