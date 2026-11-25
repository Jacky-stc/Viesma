import { toSimulationTick, type AttackId, type CharacterId, type MapState, type SimulationTick } from '@viesma/domain'
import { basicAttackEnded, canStartBasicAttack, resolveCombat, type CombatDamageEvent, type CombatStepContext } from './combat.js'
import type { MonsterDeathClaimedEvent } from './encounter-rewards.js'
import { fixedDeltaSeconds } from './fixed-tick.js'
import { advanceMonsters, type MonsterStepContext } from './monster-ai.js'
import type { SimulationMonster } from './monster.js'
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
  readonly map: Omit<MapState, 'players' | 'monsters'> & {
    readonly players: readonly SimulationPlayer[]
    readonly monsters: readonly SimulationMonster[]
  }
}

export type SimulationCommand = PlayerInputCommand
export type SimulationEvent = PlayerLifecycleEvent | CombatDamageEvent | MonsterDeathClaimedEvent

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
  readonly monsters?: MonsterStepContext
  readonly combat?: CombatStepContext
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
  const events: SimulationEvent[] = []
  const { tick, rng } = context
  const { mapInstanceId, mapId } = state.map
  const combat = mapId === 'village' ? undefined : context.combat
  const advancedPlayers = advancePlayers(state, inputs, context, combat, events)
  const advancedMonsters = advanceMonsters(state.map.monsters, advancedPlayers, tick, context.monsters, rng)
  const { players, monsters } = combat
    ? resolveCombat(advancedPlayers, advancedMonsters, { tick, mapId, mapInstanceId }, combat, rng, events)
    : { players: advancedPlayers, monsters: advancedMonsters }
  const map = players === state.map.players && monsters === state.map.monsters ? state.map : { ...state.map, players, monsters }
  return { state: { ...state, tick: context.tick, map }, events }
}

function advancePlayers(
  state: SimulationState,
  inputs: ReadonlyMap<CharacterId, SelectedInput>,
  context: SimulationContext,
  combat: CombatStepContext | undefined,
  events: SimulationEvent[]
): readonly SimulationPlayer[] {
  if (state.map.players.length === 0) return state.map.players
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
  return [...state.map.players]
    .sort((left, right) => (left.characterId < right.characterId ? -1 : Number(left.characterId > right.characterId)))
    .map((player) => {
      if (player.lifeStartedTick === tick) return player
      if (player.action.kind === 'death') {
        const respawn = spawn && respawnPlayer(player, tick, mapInstanceId, spawn)
        if (!respawn) return player
        events.push(respawn.event)
        return respawn.player
      }

      const selected = inputs.get(player.characterId)
      const input = selected?.conflict ? undefined : selected?.command
      const updated = applyPlayerVitalEffects(player, vitalEffects.get(player.characterId) ?? [], tick)
      const attackInput = combat && combat.admitAttacks !== false && canStartBasicAttack(updated, input, tick) ? input : undefined
      const actionKinds = combat
        ? attackInput
          ? startAttack
          : basicAttackEnded(updated, tick)
            ? endAttack
            : undefined
        : actionEvents.get(player.characterId)
      const advanced = updated.vitals.hp === 0 ? updated : controller(updated, input, actionKinds, tick)
      if (advanced.vitals.hp === 0 || advanced.physics.inVoid) {
        const death = enterPlayerDeath(advanced, tick, mapInstanceId, advanced.vitals.hp === 0 ? 'damage' : 'void')
        events.push(death.event)
        return death.player
      }
      if (advanced.action.kind === 'attack') {
        if (attackInput && !advanced.action.swing) {
          return {
            ...advanced,
            spawnProtected: false,
            lastAttackStartedTick: tick,
            action: {
              ...advanced.action,
              swing: { attackId: context.ids.nextAttackId(), acceptedTick: tick, inputSeq: attackInput.seq },
            },
          }
        }
        if (advanced.spawnProtected) return { ...advanced, spawnProtected: false }
      }
      return advanced
    })
}

const startAttack = new Set<PlayerActionEvent['kind']>(['attackStarted'])
const endAttack = new Set<PlayerActionEvent['kind']>(['attackEnded'])
