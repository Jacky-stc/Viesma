import {
  isNonNegativeSafeInteger,
  toSimulationTick,
  type CharacterId,
  type MapId,
  type MapInstanceId,
  type NonNegativeSafeInteger,
  type SimulationTick,
} from '@viesma/domain'
import { initialPhysicsBalance, type GameData, type GuideDefinition, type MapPortal, type NormalizedMap } from '@viesma/game-data'
import { selectInputCommands, type LocalMapInputCommand, type NpcInteractionRequest } from './movement-input.js'
import { createPlayerController } from './player-controller.js'
import { respawnPlayer, type PlayerLifecycleEvent } from './player-lifecycle.js'
import { createPlayer, placePlayerAtSpawn, type SimulationPlayer } from './player.js'
import { stepWithSelectedInputs, type SimulationContext, type SimulationState } from './step.js'

export interface LocalWorldState extends SimulationState {
  readonly mapEpoch: NonNegativeSafeInteger
  readonly guideInteraction: GuideInteraction | null
}

export interface GuideInteraction {
  readonly mapId: MapId
  readonly mapEpoch: NonNegativeSafeInteger
  readonly npcId: string
  readonly openedAtTick: SimulationTick
}

type GuideCloseReason = 'requested' | 'outOfRange' | 'death' | 'mapChanged'

export type LocalGuideEvent = {
  readonly tick: SimulationTick
  readonly characterId: CharacterId
  readonly interaction: GuideInteraction
} & ({ readonly kind: 'guideOpened' } | { readonly kind: 'guideClosed'; readonly reason: GuideCloseReason })

export interface LocalPortalEvent {
  readonly kind: 'playerTransferred'
  readonly characterId: CharacterId
  readonly tick: SimulationTick
  readonly sourceMapId: MapId
  readonly portalId: MapPortal['id']
  readonly mapId: MapId
  readonly spawnId: MapPortal['destinationSpawnId']
}

type LocalWorldEvent = PlayerLifecycleEvent | LocalPortalEvent | LocalGuideEvent

interface LocalWorldStepResult {
  readonly state: LocalWorldState
  readonly events: readonly LocalWorldEvent[]
}

function canUseGroundedInteraction(player: SimulationPlayer): boolean {
  return player.vitals.hp > 0 && player.action.kind === 'none' && player.physics.grounded && !player.physics.inVoid
}

function isGuideInRange(guide: GuideDefinition, mapId: MapId, player: SimulationPlayer): boolean {
  if (mapId !== guide.mapId) return false
  const { bodyWidthWorldUnits, bodyHeightWorldUnits } = initialPhysicsBalance
  const x = player.position.x + bodyWidthWorldUnits / 2 - guide.npc.position.x
  const y = player.position.y + bodyHeightWorldUnits - guide.npc.position.y
  return x * x + y * y <= guide.interactionDistanceWorldUnits ** 2
}

function updateGuide(
  guide: GuideDefinition | undefined,
  previous: LocalWorldState,
  state: LocalWorldState,
  events: readonly LocalWorldEvent[],
  request: NpcInteractionRequest | undefined
): LocalWorldStepResult {
  const [player] = state.map.players
  const [before] = previous.map.players
  if (!guide || !player || !before) return { state, events }
  const { guideInteraction: interaction } = previous
  const { characterId } = player
  const {
    tick,
    mapEpoch,
    map: { mapId },
  } = state
  const matchingRequest = request?.npcId === guide.npc.id ? request : undefined
  const inRange = isGuideInRange(guide, mapId, player)

  if (interaction) {
    let reason: GuideCloseReason | undefined
    if (mapEpoch !== interaction.mapEpoch || mapId !== interaction.mapId) reason = 'mapChanged'
    else if (player.action.kind === 'death' || player.vitals.hp === 0 || player.physics.inVoid) reason = 'death'
    else if (!inRange) reason = 'outOfRange'
    else if (matchingRequest?.kind === 'toggle' || matchingRequest?.openedAtTick === interaction.openedAtTick) reason = 'requested'
    if (reason) {
      return {
        state: { ...state, guideInteraction: null },
        events: [...events, { kind: 'guideClosed', reason, characterId, tick, interaction }],
      }
    }
  } else if (
    matchingRequest?.kind === 'toggle' &&
    inRange &&
    mapEpoch === previous.mapEpoch &&
    canUseGroundedInteraction(before) &&
    canUseGroundedInteraction(player) &&
    isGuideInRange(guide, mapId, before)
  ) {
    const interaction = { mapId, mapEpoch, npcId: guide.npc.id, openedAtTick: tick }
    return {
      state: { ...state, guideInteraction: interaction },
      events: [...events, { kind: 'guideOpened', characterId, tick, interaction }],
    }
  }
  return { state, events }
}

export function findOverlappingPortal(map: NormalizedMap, position: SimulationPlayer['position']): MapPortal | undefined {
  const { bodyWidthWorldUnits, bodyHeightWorldUnits } = initialPhysicsBalance
  return map.portals.find(
    ({ bounds: { origin, width, height } }) =>
      position.x < origin.x + width &&
      position.x + bodyWidthWorldUnits > origin.x &&
      position.y < origin.y + height &&
      position.y + bodyHeightWorldUnits > origin.y
  )
}

function localMap(mapId: MapId, player: SimulationPlayer): SimulationState['map'] {
  return { mapId, mapInstanceId: `local:${mapId}` as MapInstanceId, players: [player], monsters: [], attacks: [] }
}

function changeMap(state: LocalWorldState, mapId: MapId, player: SimulationPlayer): LocalWorldState {
  const mapEpoch = state.mapEpoch + 1
  if (!isNonNegativeSafeInteger(mapEpoch)) throw new RangeError('Local map epoch exceeded the safe integer limit')
  return { ...state, mapEpoch, map: localMap(mapId, player) }
}

export function createLocalWorld(data: GameData & { readonly guide?: GuideDefinition }, characterId: CharacterId) {
  const { guide } = data
  const definitions = new Map(data.world.maps.map((map) => [map.id, map]))
  const maps = new Map(
    data.tiledMaps.map((map) => [
      map.id,
      {
        map,
        controller: createPlayerController(map),
        safe: definitions.get(map.id)?.recommendedLevels === null,
      },
    ])
  )
  const { mapId: hubId, spawnId } = data.world.respawn
  const hub = maps.get(hubId)
  const spawn = hub?.map.spawns.find((candidate) => candidate.id === spawnId)
  if (!hub?.safe || !spawn) throw new RangeError('Local world requires the imported safe hub and respawn point')
  const respawnTarget = { ...spawn, mapId: hubId, spawnId }
  const tick = toSimulationTick(0)
  const initialState: LocalWorldState = {
    tick,
    mapEpoch: tick,
    guideInteraction: null,
    map: localMap(hubId, createPlayer(characterId, spawn.position, true, spawn.facing)),
  }

  return {
    initialState,
    canInteractWithGuide(state: LocalWorldState): boolean {
      const [player] = state.map.players
      return Boolean(guide && player && canUseGroundedInteraction(player) && isGuideInRange(guide, state.map.mapId, player))
    },
    advance(
      state: LocalWorldState,
      commands: readonly LocalMapInputCommand[],
      dtSeconds: number,
      context: Omit<SimulationContext, 'playerController' | 'playerRespawn'>
    ): LocalWorldStepResult {
      const source = maps.get(state.map.mapId)
      const [player] = state.map.players
      if (!source || !player || player.characterId !== characterId || state.map.players.length !== 1) {
        throw new RangeError('Local world requires one character on a loaded source map')
      }
      const inputs = selectInputCommands(commands, new Map([[characterId, player.lifeStartedTick]]), state.mapEpoch)
      const result = stepWithSelectedInputs(state, inputs, dtSeconds, {
        ...context,
        playerController: source.controller,
        ...(source.safe && { playerVitalEffects: context.playerVitalEffects?.filter((effect) => effect?.kind !== 'damage') ?? [] }),
      })
      const advanced = { ...state, ...result.state }
      const [nextPlayer] = advanced.map.players
      if (nextPlayer === undefined) throw new Error('Local step lost its character')

      const respawn = respawnPlayer(nextPlayer, context.tick, state.map.mapInstanceId, respawnTarget)
      if (respawn) {
        return updateGuide(guide, state, changeMap(advanced, hubId, respawn.player), [...result.events, respawn.event], undefined)
      }

      const input = inputs.get(characterId)
      const lastSeq = player.movement.lastProcessedInputSeq
      const command =
        input && !input.conflict && 'portalPressed' in input.command && (lastSeq === null || input.command.seq > lastSeq)
          ? input.command
          : undefined
      const portal =
        command?.portalPressed && canUseGroundedInteraction(player) && canUseGroundedInteraction(nextPlayer)
          ? findOverlappingPortal(source.map, player.position)
          : undefined
      const destination = portal && maps.get(portal.destinationMapId)
      const arrival = destination?.map.spawns.find(({ id }) => id === portal?.destinationSpawnId)
      if (!portal || !destination || !arrival) return updateGuide(guide, state, advanced, result.events, command?.npcInteraction)

      const placed = {
        ...placePlayerAtSpawn(nextPlayer, arrival.position, arrival.facing),
        spawnProtected: !destination.safe,
        spawnProtectionStartedTick: context.tick,
      }
      return updateGuide(
        guide,
        state,
        changeMap(advanced, destination.map.id, placed),
        [
          ...result.events,
          {
            kind: 'playerTransferred',
            characterId,
            tick: context.tick,
            sourceMapId: source.map.id,
            portalId: portal.id,
            mapId: destination.map.id,
            spawnId: arrival.id,
          },
        ],
        undefined
      )
    },
  }
}
