import type { CharacterId } from '@viesma/domain'
import type { CombatDamageEvent, PlayerControllerState, SimulationPlayer } from '@viesma/simulation'

export type InputDecision = 'queued' | 'dead' | 'frozen' | 'rate' | 'invalid-frame' | 'epoch' | 'ahead' | 'duplicate' | 'queue-full'

type MovementTraceEvent =
  | { kind: 'input-decision'; serverTick: number; inputSeq: number | null; reason: InputDecision; queueDepth: number }
  | {
      kind: 'input-retired'
      serverTick: number
      inputSeq: number
      reason: 'ttl' | 'evicted' | 'conflict' | 'cleared' | 'death'
      ageMs: number | null
    }
  | { kind: 'tick'; serverTick: number; inputSeq: number | null; jumpPressed: boolean; before: SimulationPlayer; after: SimulationPlayer }
  | {
      kind: 'controller'
      serverTick: number
      inputSeq: number | null
      jumpPressed: boolean
      before: PlayerControllerState
      after: PlayerControllerState
    }
  | { kind: 'damage'; event: Extract<CombatDamageEvent, { kind: 'playerDamaged' }> }

export type MovementTraceSink = (event: MovementTraceEvent) => void
export type WatchMovement = (characterId: CharacterId) => MovementTraceSink | undefined
