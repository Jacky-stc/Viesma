import { isNonNegativeSafeInteger, type CharacterId, type MoveX } from '@viesma/domain'
import { initialPlayerLifecycleBalance, loadGrayboxGameData } from '@viesma/game-data'
import {
  createFixedTickDriver,
  createLocalWorld,
  createSeededRng,
  ticksPerSecond,
  type GuideInteraction,
  type NpcInteractionRequest,
  type PlayerActionEvent,
  type PlayerVitalEffect,
  type SimulationIdSource,
} from '@viesma/simulation'
import type { AuxiliaryAction, InputSample } from '../input/input-state'
import { interpolatePlayer, projectPlayer } from '../rendering/player-view'

const characterId = 'playground-beginner' as CharacterId
const data = loadGrayboxGameData()
const localWorld = createLocalWorld(data, characterId)
const maps = new Map(data.tiledMaps.map((map) => [map.id, map]))
export const mapNames = new Map(data.world.maps.map(({ id, name }) => [id, name]))
const portalTick = 72
const lethalTick = 225
const hurtTick = lethalTick - initialPlayerLifecycleBalance.hurtImmunityTicks
const cycleTicks = lethalTick + initialPlayerLifecycleBalance.respawnDelayTicks + initialPlayerLifecycleBalance.respawnProtectionTicks
const attackFixtureTicks = 15
const jumpTicks = new Set([16, 112, 163])
const actionTicks = new Map<number, PlayerActionEvent['kind']>([
  [166, 'attackStarted'],
  [166 + attackFixtureTicks, 'attackEnded'],
])

const ids: SimulationIdSource = {
  nextAttackId() {
    throw new Error('The playground has no attack entities')
  },
}

export type DebugDamage = 'damage' | 'lethal'

interface InteractivePlaygroundInput {
  readonly sample: () => InputSample
  readonly clear: () => void
  readonly publishActions: (actions: readonly AuxiliaryAction[]) => void
  readonly takeGuideClose?: () => GuideInteraction | undefined
  readonly takeDebugDamage?: () => DebugDamage | undefined
}

export function createPlayground(startMilliseconds: number, input?: InteractivePlaygroundInput) {
  let state = localWorld.initialState
  const [initialPlayer] = state.map.players
  if (!initialPlayer) throw new Error('Missing initial playground player')
  let player = initialPlayer
  const hubPosition = initialPlayer.position
  let current = projectPlayer(player, state.tick)
  let previous = current
  let frameMilliseconds = startMilliseconds
  let attackEndTick = 0
  const rng = createSeededRng(1)

  const driver = createFixedTickDriver({ nowMilliseconds: () => frameMilliseconds }, ({ tick, dtSeconds }) => {
    const cycleTick = tick % cycleTicks
    const sample = input?.sample()
    const close = input?.takeGuideClose?.()
    const guide = state.map.mapId === data.guide.mapId ? data.guide : undefined
    let npcInteraction: NpcInteractionRequest | undefined
    if (close?.mapEpoch === state.mapEpoch) {
      npcInteraction = { kind: 'close', npcId: close.npcId, openedAtTick: close.openedAtTick }
    } else if (guide && sample?.actions.includes('interact')) {
      npcInteraction = { kind: 'toggle', npcId: guide.npc.id }
    }
    const moveX: MoveX = sample?.moveX ?? (cycleTick >= 13 && cycleTick < 151 ? 1 : cycleTick >= 155 && cycleTick < 218 ? -1 : 0)
    const { lifeStartedTick } = player
    const alive = player.action.kind !== 'death'
    const playerActionEvents: PlayerActionEvent[] = []
    if (sample && alive) {
      if (tick === attackEndTick) playerActionEvents.push({ kind: 'attackEnded', characterId, lifeStartedTick })
      if (sample.attackPressed && tick >= attackEndTick) playerActionEvents.push({ kind: 'attackStarted', characterId, lifeStartedTick })
    } else if (!input) {
      const action = actionTicks.get(cycleTick)
      if (action !== undefined) playerActionEvents.push({ kind: action, characterId, lifeStartedTick })
    }
    const damage = input ? input.takeDebugDamage?.() : cycleTick === hurtTick ? 'damage' : cycleTick === lethalTick ? 'lethal' : undefined
    const amount = damage === 'damage' ? 10 : damage === 'lethal' ? player.vitals.maxHp : 0
    const order = 0
    const playerVitalEffects: PlayerVitalEffect[] = []
    if (alive && amount > 0 && isNonNegativeSafeInteger(amount) && isNonNegativeSafeInteger(order)) {
      playerVitalEffects.push({ kind: 'damage', characterId, lifeStartedTick, tick, order, amount })
    }
    const result = localWorld.advance(
      state,
      [
        {
          kind: 'input',
          characterId,
          lifeStartedTick,
          mapEpoch: state.mapEpoch,
          seq: tick,
          moveX,
          jumpPressed: sample?.jumpPressed ?? jumpTicks.has(cycleTick),
          portalPressed: sample?.portalPressed ?? cycleTick === portalTick,
          ...(npcInteraction && { npcInteraction }),
        },
      ],
      dtSeconds,
      { tick, rng, ids, playerActionEvents, playerVitalEffects }
    )
    const relocated = result.state.mapEpoch !== state.mapEpoch
    state = result.state
    const [nextPlayer] = state.map.players
    if (!nextPlayer) throw new Error('Missing playground player')
    if (sample) {
      if (nextPlayer.action.kind !== 'attack') attackEndTick = 0
      else if (tick >= attackEndTick) attackEndTick = tick + attackFixtureTicks
    }
    player = nextPlayer
    previous = current
    current = projectPlayer(player, state.tick)
    if (relocated) previous = current
    // 傳送或對話開關時保留實體按鍵狀態；死亡及重生會清除輸入。
    const lifeChanged = result.events.some(({ kind }) => kind === 'playerDied' || kind === 'playerRespawned')
    if (lifeChanged) input?.clear()
    if (relocated || lifeChanged) {
      input?.publishActions([])
    } else if (sample && alive && sample.actions.length > 0) {
      input?.publishActions(sample.actions)
    }
    return undefined
  })

  return {
    advance(nowMilliseconds: number) {
      frameMilliseconds = nowMilliseconds
      const { tick, backlogTicks } = driver.advance()
      const alpha = backlogTicks > 0 ? 1 : ((nowMilliseconds - startMilliseconds) * ticksPerSecond) / 1000 - tick
      const map = maps.get(state.map.mapId)
      if (!map) throw new Error('Missing active playground map')
      const frame = interpolatePlayer(previous, current, alpha)
      const atSafeHubSpawn =
        map.id === data.world.respawn.mapId &&
        frame.state !== 'death' &&
        frame.position.x === hubPosition.x &&
        frame.position.y === hubPosition.y
      return {
        ...frame,
        map,
        atSafeHubSpawn,
        guide: map.id === data.guide.mapId ? data.guide : undefined,
        guideInteraction: state.guideInteraction,
        canInteractWithGuide: localWorld.canInteractWithGuide(state),
      }
    },
  }
}
