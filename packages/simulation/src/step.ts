import { toSimulationTick, type AttackId, type CharacterId, type MapState, type SimulationTick } from '@viesma/domain'
import { fixedDeltaSeconds } from './fixed-tick.js'
import { selectInputCommands, type PlayerInputCommand, type SelectedInput } from './movement-input.js'
import type { PlayerController } from './player-controller.js'
import {
  applyPlayerVitalEffects,
  enterPlayerDeath,
  respawnPlayer,
  selectPlayerVitalEffects,
  type PlayerLifecycleEvent,
  type PlayerVitalEffect,
} from './player-lifecycle.js'
import type { PlayerActionEvent, SimulationPlayer } from './player.js'
import type { RandomSource } from './random.js'
import { resolveSafeHubSpawn, type SafeHubSpawn } from './safe-hub.js'

export interface SimulationState {
  readonly tick: SimulationTick
  readonly map: Omit<MapState, 'players'> & { readonly players: readonly SimulationPlayer[] }
}

export type SimulationCommand = PlayerInputCommand
export type SimulationEvent = PlayerLifecycleEvent

export interface SimulationIdSource {
  nextAttackId(): AttackId
}

export interface SimulationContext {
  readonly tick: SimulationTick
  readonly rng: RandomSource
  readonly ids: SimulationIdSource
  readonly playerController?: PlayerController
  readonly playerActionEvents?: readonly PlayerActionEvent[]
  readonly playerVitalEffects?: readonly PlayerVitalEffect[]
  readonly playerRespawn?: SafeHubSpawn
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
  const playerLives = new Map(state.map.players.map(({ characterId, lifeStartedTick }) => [characterId, lifeStartedTick]))
  return stepWithSelectedInputs(state, selectInputCommands(commands, playerLives), dtSeconds, context)
}

export function stepWithSelectedInputs(
  state: SimulationState,
  inputs: ReadonlyMap<CharacterId, SelectedInput>,
  dtSeconds: number,
  context: SimulationContext
): SimulationStepResult {
  if (dtSeconds !== fixedDeltaSeconds || context.tick !== toSimulationTick(state.tick + 1)) {
    throw new RangeError('Simulation step requires one fixed delta and the next tick')
  }
  if (state.map.players.length === 0) {
    return { state: { ...state, tick: context.tick }, events: [] }
  }
  const controller = context.playerController
  if (controller === undefined) throw new RangeError('Simulation step requires a player controller for maps with players')

  const playerLives = new Map(state.map.players.map(({ characterId, lifeStartedTick }) => [characterId, lifeStartedTick]))
  const vitalEffects = selectPlayerVitalEffects(context.playerVitalEffects ?? [], playerLives, context.tick)
  const spawn = resolveSafeHubSpawn(context.playerRespawn, state.map.mapId)
  const actionEvents = new Map<CharacterId, Set<PlayerActionEvent['kind']>>()
  for (const event of context.playerActionEvents ?? []) {
    if (
      (event?.kind !== 'attackStarted' && event?.kind !== 'attackEnded') ||
      !playerLives.has(event.characterId) ||
      event.lifeStartedTick !== playerLives.get(event.characterId)
    )
      continue
    const kinds = actionEvents.get(event.characterId)
    if (kinds === undefined) {
      actionEvents.set(event.characterId, new Set([event.kind]))
    } else {
      kinds.add(event.kind)
    }
  }

  const { tick } = context
  const { mapInstanceId } = state.map
  const events: SimulationEvent[] = []
  const players = [...state.map.players]
    .sort((left, right) => (left.characterId < right.characterId ? -1 : Number(left.characterId > right.characterId)))
    .map((player) => {
      if (player.action.kind === 'death') {
        const respawn = spawn && respawnPlayer(player, tick, mapInstanceId, spawn)
        if (!respawn) return player
        events.push(respawn.event)
        return respawn.player
      }

      const input = inputs.get(player.characterId)
      const updated = applyPlayerVitalEffects(player, vitalEffects.get(player.characterId) ?? [], tick)
      const advanced =
        updated.vitals.hp === 0
          ? updated
          : controller(updated, input?.conflict ? undefined : input?.command, actionEvents.get(player.characterId), tick)
      if (advanced.vitals.hp === 0 || advanced.physics.inVoid) {
        const death = enterPlayerDeath(advanced, tick, mapInstanceId, advanced.vitals.hp === 0 ? 'damage' : 'void')
        events.push(death.event)
        return death.player
      }
      if (advanced.spawnProtected && advanced.action.kind === 'attack') return { ...advanced, spawnProtected: false }
      return advanced
    })
  return { state: { ...state, tick, map: { ...state.map, players } }, events }
}
