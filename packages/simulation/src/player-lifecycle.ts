import {
  isNonNegativeSafeInteger,
  type CharacterId,
  type DeathId,
  type MapId,
  type MapInstanceId,
  type NonNegativeSafeInteger,
  type SimulationTick,
} from '@viesma/domain'
import { initialPlayerLifecycleBalance, type SpawnId } from '@viesma/game-data'
import { neutralMovement, placePlayerAtSpawn, type FacingDirection, type SimulationPlayer } from './player.js'
import type { SafeHubSpawn } from './safe-hub.js'

export interface PlayerVitalEffect {
  readonly kind: 'damage' | 'heal' | 'spendMp' | 'restoreMp'
  readonly characterId: CharacterId
  readonly lifeStartedTick: SimulationTick
  readonly tick: SimulationTick
  readonly order: NonNegativeSafeInteger
  readonly amount: NonNegativeSafeInteger
}

type PlayerDeathCause = 'damage' | 'void'

interface PlayerLifecycleEventFields {
  readonly characterId: CharacterId
  readonly tick: SimulationTick
  readonly deathId: DeathId
}

export type PlayerLifecycleEvent = PlayerLifecycleEventFields &
  (
    | { readonly kind: 'playerDied'; readonly cause: PlayerDeathCause }
    | { readonly kind: 'playerRespawned'; readonly mapId: MapId; readonly spawnId: SpawnId }
  )

const balance = initialPlayerLifecycleBalance

export function selectPlayerVitalEffects(
  effects: readonly PlayerVitalEffect[],
  playerLives: ReadonlyMap<CharacterId, SimulationTick>,
  tick: SimulationTick
): ReadonlyMap<CharacterId, readonly PlayerVitalEffect[]> {
  const byPlayer = new Map<CharacterId, Map<number, PlayerVitalEffect | null>>()
  for (const effect of effects) {
    if (
      effect == null ||
      effect.tick !== tick ||
      !playerLives.has(effect.characterId) ||
      effect.lifeStartedTick !== playerLives.get(effect.characterId) ||
      !isNonNegativeSafeInteger(effect.order) ||
      !isNonNegativeSafeInteger(effect.amount) ||
      effect.amount === 0 ||
      (effect.kind !== 'damage' && effect.kind !== 'heal' && effect.kind !== 'spendMp' && effect.kind !== 'restoreMp')
    )
      continue

    let slots = byPlayer.get(effect.characterId)
    if (!slots) {
      slots = new Map()
      byPlayer.set(effect.characterId, slots)
    }
    const previous = slots.get(effect.order)
    if (previous === undefined) {
      slots.set(effect.order, effect)
    } else if (previous && (previous.kind !== effect.kind || previous.amount !== effect.amount)) {
      slots.set(effect.order, null)
    }
  }

  return new Map(
    Array.from(byPlayer, ([characterId, slots]) => [
      characterId,
      Array.from(slots.values())
        .filter((effect) => effect !== null)
        .sort((a, b) => a.order - b.order),
    ])
  )
}

export function applyPlayerVitalEffects(
  player: SimulationPlayer,
  effects: readonly PlayerVitalEffect[],
  tick: SimulationTick
): SimulationPlayer {
  const { maxHp, maxMp } = player.vitals
  let { hp, mp } = player.vitals
  let { lastHurtTick } = player
  const spawnProtected = player.spawnProtected && tick - player.spawnProtectionStartedTick < balance.respawnProtectionTicks
  for (const { kind, amount } of effects) {
    switch (kind) {
      case 'damage':
        if (spawnProtected || (lastHurtTick !== null && tick - lastHurtTick < balance.hurtImmunityTicks)) break
        hp = Math.max(0, hp - amount)
        lastHurtTick = tick
        break
      case 'heal':
        hp += Math.min(maxHp - hp, amount)
        break
      case 'spendMp':
        mp = Math.max(0, mp - amount)
        break
      case 'restoreMp':
        mp += Math.min(maxMp - mp, amount)
        break
    }
    if (hp === 0) break
  }
  if (
    hp === player.vitals.hp &&
    mp === player.vitals.mp &&
    lastHurtTick === player.lastHurtTick &&
    spawnProtected === player.spawnProtected
  ) {
    return player
  }
  return { ...player, vitals: { hp, maxHp, mp, maxMp }, lastHurtTick, spawnProtected }
}

function deathIdFor(mapInstanceId: MapInstanceId, characterId: CharacterId, tick: SimulationTick): DeathId {
  return JSON.stringify([mapInstanceId, characterId, tick]) as DeathId
}

export function enterPlayerDeath(
  player: SimulationPlayer,
  tick: SimulationTick,
  mapInstanceId: MapInstanceId,
  cause: PlayerDeathCause
): { player: SimulationPlayer; event: PlayerLifecycleEvent } {
  return {
    player: {
      ...player,
      vitals: { ...player.vitals, hp: 0 },
      physics: { ...player.physics, velocity: { x: 0, y: 0 } },
      movement: { ...neutralMovement, lastProcessedInputSeq: player.movement.lastProcessedInputSeq },
      locomotion: player.physics.grounded ? 'idle' : 'fall',
      action: { kind: 'death', diedAtTick: tick },
    },
    event: {
      kind: 'playerDied',
      characterId: player.characterId,
      tick,
      deathId: deathIdFor(mapInstanceId, player.characterId, tick),
      cause,
    },
  }
}

export function respawnPlayer(
  player: SimulationPlayer,
  tick: SimulationTick,
  mapInstanceId: MapInstanceId,
  spawn: Pick<SafeHubSpawn, 'position' | 'mapId' | 'spawnId'> & { readonly facing?: FacingDirection }
): { player: SimulationPlayer; event: PlayerLifecycleEvent } | undefined {
  if (player.action.kind !== 'death' || tick - player.action.diedAtTick < balance.respawnDelayTicks) return undefined

  return {
    player: {
      ...placePlayerAtSpawn(player, spawn.position, spawn.facing ?? 'right'),
      vitals: { ...player.vitals, hp: player.vitals.maxHp, mp: player.vitals.maxMp },
      lifeStartedTick: tick,
      lastHurtTick: null,
      spawnProtected: true,
      spawnProtectionStartedTick: tick,
    },
    event: {
      kind: 'playerRespawned',
      characterId: player.characterId,
      tick,
      deathId: deathIdFor(mapInstanceId, player.characterId, player.action.diedAtTick),
      mapId: spawn.mapId,
      spawnId: spawn.spawnId,
    },
  }
}
