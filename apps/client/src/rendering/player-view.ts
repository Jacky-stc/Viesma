import type { SimulationTick, WorldPoint } from '@viesma/domain'
import {
  getPlayerPresentationState,
  type FacingDirection,
  type PlayerPresentationState,
  type PlayerVitals,
  type SimulationPlayer,
} from '@viesma/simulation'

export interface PlayerPresentation {
  readonly state: PlayerPresentationState
  readonly facing: FacingDirection
  readonly vitals: PlayerVitals
}

export interface PlayerSnapshot extends PlayerPresentation {
  readonly tick: SimulationTick
  readonly position: WorldPoint
}

export interface PlayerFrame extends PlayerPresentation {
  readonly visualTick: number
  readonly position: WorldPoint
}

export type PlayerVisualFrame = Pick<PlayerFrame, 'position' | 'state' | 'facing' | 'visualTick'>

export function projectPlayer(player: SimulationPlayer, tick: SimulationTick): PlayerSnapshot {
  return {
    tick,
    position: { ...player.position },
    state: getPlayerPresentationState(player),
    facing: player.action.kind === 'attack' ? player.action.facing : player.facing,
    vitals: { ...player.vitals },
  }
}

export function interpolatePlayer(previous: PlayerSnapshot, current: PlayerSnapshot, alpha: number): PlayerFrame {
  const weight = Math.max(0, Math.min(1, alpha))
  const { state, facing, vitals } = weight === 1 ? current : previous
  return {
    state,
    facing,
    vitals,
    position: {
      x: previous.position.x + (current.position.x - previous.position.x) * weight,
      y: previous.position.y + (current.position.y - previous.position.y) * weight,
    },
    visualTick: previous.tick + (current.tick - previous.tick) * weight,
  }
}

export const facingScale = { left: -1, right: 1 } satisfies Record<FacingDirection, number>
