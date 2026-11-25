import { Client, type Room } from '@colyseus/sdk'
import { toSimulationTick } from '@viesma/domain'
import { initialPhysicsBalance, loadGrayboxGameData, serializeMapManifest, type NormalizedMap } from '@viesma/game-data'
import { MapRoomSchema, readPublicMonsters, readPublicPlayers, type MapRoomState } from '@viesma/network-colyseus'
import {
  cancelTransferMessage,
  combatDamageMessage,
  inputFrameMessage,
  interactPortalMessage,
  mapRoomJoinedMessage,
  mapRoomName,
  movementCheckpointMessage,
  parseMapRoomSession,
  parseMovementCheckpoint,
  parseTransferFailure,
  parseTransferOffer,
  PROTOCOL_VERSION,
  transferFailureMessage,
  transferOfferMessage,
  type MapRoomSession,
  type OnlineMapId,
  type PublicPlayer,
  type TransferOffer,
} from '@viesma/protocol'
import {
  createFixedTickDriver,
  findOverlappingPortal,
  getPlayerPresentationState,
  ticksPerSecond,
  type FixedTickDriver,
} from '@viesma/simulation'
import { attachBrowserInput } from '../input/browser-input'
import { createWorldRenderer } from '../rendering/world-renderer'
import { createCombatPresentation } from './combat-presentation'
import { createCorrectionPresentation } from './correction-presentation'
import { createLocalPrediction } from './local-prediction'
import { createRemotePresentation } from './remote-presentation'

export type MultiplayerPresentation = Pick<PublicPlayer, 'hp' | 'maxHp' | 'state' | 'facing' | 'spawnProtected'> & {
  readonly players: number
  readonly mapName: string
}

interface RoomLocation {
  readonly roomId: string
  readonly mapId: OnlineMapId
  readonly mapEpoch: number
}

interface RoomScene {
  readonly room: Room<MapRoomState>
  readonly location: RoomLocation
  readonly map: NormalizedMap
  readonly correction: ReturnType<typeof createCorrectionPresentation>
  readonly remote: ReturnType<typeof createRemotePresentation>
  readonly combat: ReturnType<typeof createCombatPresentation>
  binding?: MapRoomSession
  prediction?: ReturnType<typeof createLocalPrediction>
  latest?: { self: PublicPlayer; serverTick: number; mapInstanceId: string }
  recoveryTarget?: { readonly requestId: number | null; readonly location: RoomLocation } | undefined
  respawnOffer?: TransferOffer | undefined
  requestId: number
  detach: () => void
}

interface Travel {
  readonly source: RoomScene
  readonly requestId: number | null
  readonly until: number
  offer?: TransferOffer
}

interface Recovery {
  readonly targets: readonly RoomLocation[]
  readonly characterId: string
  readonly until: number
  reconnectToken: string
  nextAttempt: number
}

const reconnectMilliseconds = 30_000
const transferWaitMilliseconds = 11_000
const reconnectRetryMilliseconds = 500
const diagnosticKeys = [
  'predictionReplayed',
  'predictionCorrection',
  'predictionCorrectionMode',
  'predictionOverflows',
  'remoteSnapshotTick',
  'remoteAuthorityX',
  'sharedMonsters',
  'remoteFrame',
  'multiplayerCharacterId',
  'multiplayerMapEpoch',
  'multiplayerSceneRevision',
  'localAuthorityX',
  'localPredictedX',
  'combatDamageSeen',
] as const

export async function runMultiplayer(
  host: HTMLElement,
  surface: HTMLElement,
  publish: (presentation: MultiplayerPresentation) => void,
  publishStatus: (status: string) => void,
  disconnect: () => void,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return
  const document = host.ownerDocument
  const diagnostics = new URLSearchParams(document.location.search).get('multiplayerDiagnostics') === '1'
  const data = loadGrayboxGameData()
  const maps = new Map<string, NormalizedMap>(data.tiledMaps.map((map) => [map.id, map]))
  const bytes = new TextEncoder().encode(serializeMapManifest(data))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const mapContentHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const version = { protocolVersion: PROTOCOL_VERSION, balanceVersion: data.balanceVersion, mapContentHash }

  const renderer = await createWorldRenderer(
    host,
    { width: initialPhysicsBalance.bodyWidthWorldUnits, height: initialPhysicsBalance.bodyHeightWorldUnits },
    signal,
    diagnostics
  )
  if (!renderer || signal.aborted) return

  const client = new Client(new URL('/multiplayer', document.location.href).href)
  const input = attachBrowserInput(surface, signal)
  let active: RoomScene | undefined
  let awaiting: RoomScene | undefined
  let travel: Travel | undefined
  let recovery: Recovery | undefined
  let connectingRecovery = false
  let previous: MultiplayerPresentation | undefined
  let driver: FixedTickDriver | undefined
  let localTick = toSimulationTick(0)
  let sceneRevision = 0

  function stopInput(scene: RoomScene) {
    driver = undefined
    scene.prediction?.suspend()
    scene.correction.reset()
    input.clearForRoomChange()
  }

  function release(scene: RoomScene, consented = true) {
    scene.detach()
    scene.prediction?.dispose()
    scene.correction.reset()
    scene.remote.clear()
    scene.combat.clear()
    void scene.room.leave(consented)
  }

  function clearDiagnostics() {
    if (diagnostics) for (const key of diagnosticKeys) delete host.dataset[key]
  }

  function activate(scene: RoomScene) {
    if (active) release(active)
    active = scene
    awaiting = undefined
    travel = undefined
    recovery = undefined
    driver = undefined
    localTick = toSimulationTick(0)
    previous = undefined
    input.clearForRoomChange()
    renderer?.resetRoom()
    clearDiagnostics()
    sceneRevision++
    publishStatus('')
  }

  function startRecovery(binding: MapRoomSession, targets: readonly RoomLocation[]) {
    if (active) {
      stopInput(active)
      active.remote.clear()
      active.combat.clear()
    }
    travel = undefined
    recovery = {
      targets,
      characterId: binding.characterId,
      reconnectToken: binding.reconnectToken,
      nextAttempt: performance.now(),
      until: performance.now() + reconnectMilliseconds,
    }
    publishStatus('正在重連，保留原角色…')
  }

  function failTravel(attempt: Travel, message: string, cancel: boolean) {
    if (signal.aborted || travel !== attempt) return
    const { source, offer } = attempt
    const candidate = awaiting
    awaiting = undefined
    if (candidate) release(candidate, false)
    if (candidate?.binding) {
      startRecovery(candidate.binding, [candidate.location])
    } else if (!source.room.connection.isOpen && source.binding) {
      startRecovery(source.binding, offer ? [offer, source.location] : [source.location])
    } else {
      travel = undefined
      if (cancel && offer) source.room.send(cancelTransferMessage, { ticket: offer.ticket })
      stopInput(source)
      publishStatus(message)
    }
  }

  async function joinDestination(attempt: Travel, offer: TransferOffer, binding: MapRoomSession) {
    try {
      const room = await client.joinById<MapRoomState>(
        offer.roomId,
        { ...version, ticket: offer.ticket, reconnectToken: binding.reconnectToken },
        MapRoomSchema
      )
      if (signal.aborted || travel !== attempt) {
        room.reconnection.enabled = false
        // 逾時後才收到入房確認時，已提交的角色仍需在目的房保留重連資格。
        void room.leave(signal.aborted)
        return
      }
      attachRoom(room, offer, binding.characterId)
    } catch {
      failTravel(attempt, '傳送失敗，請重新按 ↑。', true)
    }
  }

  async function tryReconnect(attempt: Recovery) {
    connectingRecovery = true
    try {
      for (const target of attempt.targets) {
        if (signal.aborted || recovery !== attempt || performance.now() >= attempt.until) return
        let room: Room<MapRoomState>
        try {
          room = await client.joinById<MapRoomState>(target.roomId, { ...version, reconnectToken: attempt.reconnectToken }, MapRoomSchema)
        } catch {
          continue
        }
        if (signal.aborted || recovery !== attempt) {
          void room.leave()
          return
        }
        attachRoom(room, target, attempt.characterId)
        return
      }
    } finally {
      attempt.nextAttempt = performance.now() + reconnectRetryMilliseconds
      connectingRecovery = false
    }
  }

  function attachRoom(room: Room<MapRoomState>, location: RoomLocation, characterId?: string) {
    room.reconnection.enabled = false
    const map = maps.get(location.mapId)
    if (!map) {
      void room.leave()
      disconnect()
      return
    }
    const scene: RoomScene = {
      room,
      location,
      map,
      correction: createCorrectionPresentation(map),
      remote: createRemotePresentation(),
      combat: createCombatPresentation(),
      requestId: 0,
      detach: () => {
        unbindJoin()
        unbindCheckpoint()
        unbindCombatDamage()
        unbindOffer()
        unbindFailure()
        room.onStateChange.remove(receiveState)
        room.onLeave.remove(onLeave)
      },
    }
    awaiting = scene
    const isCurrent = () => !signal.aborted && (active === scene || awaiting === scene)

    function receiveState(state: MapRoomState) {
      const { binding, latest } = scene
      if (!isCurrent() || !binding || !state.mapId) return
      if (
        state.mapId !== map?.id ||
        state.mapContentHash !== mapContentHash ||
        !state.mapInstanceId ||
        (latest && state.mapInstanceId !== latest.mapInstanceId) ||
        !Number.isSafeInteger(state.serverTick) ||
        state.serverTick < 0
      ) {
        disconnect()
        return
      }
      if (latest && state.serverTick <= latest.serverTick) return
      const players = readPublicPlayers(state)
      const self = players.find((player) => player.characterId === binding.characterId && player.mapEpoch === binding.mapEpoch)
      if (!self) return
      const { serverTick, mapInstanceId, mapId } = state
      const peers = players.filter((player) => player !== self)
      const monsters = readPublicMonsters(state)
      scene.combat.snapshot(mapInstanceId, serverTick, players, monsters)
      scene.remote.receive(
        { mapInstanceId, mapId, connectionEpoch: binding.connectionEpoch, mapEpoch: self.mapEpoch },
        serverTick,
        performance.now(),
        peers,
        monsters
      )
      scene.latest = { self, serverTick, mapInstanceId }
      if (diagnostics && active === scene) {
        host.dataset.remoteSnapshotTick = String(serverTick)
        host.dataset.remoteAuthorityX = String(peers[0]?.x ?? '')
        host.dataset.sharedMonsters = JSON.stringify(monsters)
      }
    }

    const unbindJoin = room.onMessage(mapRoomJoinedMessage, (payload: unknown) => {
      if (!isCurrent() || scene.binding) return
      const binding = parseMapRoomSession(payload)
      if (!binding || binding.mapEpoch !== location.mapEpoch || (characterId && binding.characterId !== characterId)) {
        disconnect()
        return
      }
      scene.binding = binding
      receiveState(room.state)
    })
    const unbindCombatDamage = room.onMessage(combatDamageMessage, (payload: unknown) => {
      if (isCurrent() && active === scene && !recovery) scene.combat.receive(payload, performance.now())
    })
    const unbindCheckpoint = room.onMessage(movementCheckpointMessage, (payload: unknown) => {
      const { binding, latest, correction } = scene
      if (!isCurrent() || !binding || !latest) return
      const checkpoint = parseMovementCheckpoint(payload)
      if (!checkpoint || checkpoint.serverTick > latest.serverTick || checkpoint.mapEpoch !== binding.mapEpoch) return
      const prediction = (scene.prediction ??= createLocalPrediction(map, latest.mapInstanceId, binding))
      const before = prediction.predicted?.controller.position
      const result = prediction.receive(checkpoint)
      const after = prediction.predicted?.controller.position
      if (result === 'ignored' || !after) return
      if (awaiting === scene) activate(scene)
      const { lastCorrectionWorldUnits, replayedInputs } = prediction.diagnostics
      let mode = result === 'reconciled' ? 'none' : 'snap'
      if (result === 'reconciled' && before) {
        if (lastCorrectionWorldUnits > 0) mode = correction.correct(before, after, performance.now()) ? 'smooth' : 'snap'
      } else {
        correction.reset()
        if (result === 'reset') input.clearForRoomChange()
      }
      if (diagnostics) {
        host.dataset.predictionReplayed = String(replayedInputs)
        host.dataset.localAuthorityX = String(checkpoint.controller.position.x)
        host.dataset.multiplayerCharacterId = binding.characterId
        host.dataset.multiplayerMapEpoch = String(binding.mapEpoch)
        host.dataset.multiplayerSceneRevision = String(sceneRevision)
        if (mode !== 'none') {
          host.dataset.predictionCorrection = String(lastCorrectionWorldUnits)
          host.dataset.predictionCorrectionMode = mode
        }
      }
      if (scene.respawnOffer) {
        const offer = scene.respawnOffer
        scene.respawnOffer = undefined
        receiveOffer(offer)
      }
    })
    function receiveOffer(offer: TransferOffer) {
      const binding = scene.binding
      if (!isCurrent() || !binding || offer.mapEpoch !== binding.mapEpoch + 1 || offer.mapId === location.mapId) return
      if (awaiting === scene && offer.requestId === null) {
        scene.respawnOffer = offer
        return
      }
      if (active !== scene) return
      if (!travel?.offer && offer.requestId === null) {
        stopInput(scene)
        travel = { source: scene, requestId: null, until: performance.now() + transferWaitMilliseconds }
        publishStatus('正在返回 Village…')
      }
      if (travel?.source !== scene || travel.requestId !== offer.requestId || travel.offer) return
      travel.offer = offer
      scene.recoveryTarget = {
        requestId: offer.requestId,
        location: { roomId: offer.roomId, mapId: offer.mapId, mapEpoch: offer.mapEpoch },
      }
      void joinDestination(travel, offer, binding)
    }
    const unbindOffer = room.onMessage(transferOfferMessage, (payload: unknown) => {
      const offer = parseTransferOffer(payload)
      if (offer) receiveOffer(offer)
    })
    const unbindFailure = room.onMessage(transferFailureMessage, (payload: unknown) => {
      const failure = parseTransferFailure(payload)
      if (!isCurrent() || active !== scene || !failure) return
      if (scene.recoveryTarget?.requestId === failure.requestId) scene.recoveryTarget = undefined
      const message =
        failure.code === 'MAP_SEAT_UNAVAILABLE'
          ? '目的地已滿。'
          : failure.code === 'WORLD_TICK_BACKLOG'
            ? '伺服器忙碌中，請稍後再試。'
            : failure.requestId === null
              ? '暫時無法返回 Village，將再次嘗試。'
              : '無法傳送，請站在傳送門內重新按 ↑。'
      if (travel?.source === scene && travel.requestId === failure.requestId) failTravel(travel, message, false)
      else if (failure.requestId === null && !travel) publishStatus(message)
    })
    function onLeave() {
      if (!isCurrent()) return
      if (active === scene) {
        stopInput(scene)
        if (travel?.source === scene && travel.offer) return
      }
      if (awaiting === scene && travel) {
        failTravel(travel, '傳送失敗，請重新按 ↑。', true)
        return
      }
      scene.detach()
      if (awaiting === scene) awaiting = undefined
      if (recovery) {
        if (scene.binding) recovery.reconnectToken = scene.binding.reconnectToken
      } else if (scene.binding) {
        const target = scene.recoveryTarget?.location
        startRecovery(scene.binding, target ? [target, scene.location] : [scene.location])
      } else {
        disconnect()
      }
    }
    room.onStateChange(receiveState)
    room.onLeave(onLeave)
  }

  function startClock() {
    const scene = active
    if (
      !scene ||
      !scene.binding ||
      !scene.prediction ||
      !scene.prediction.ready ||
      driver ||
      travel ||
      recovery ||
      document.hidden ||
      !scene.room.connection.isOpen
    )
      return
    const { binding, prediction, room } = scene
    driver = createFixedTickDriver(
      { nowMilliseconds: () => performance.now() },
      ({ tick }) => {
        if (active !== scene || !driver || !prediction.ready || !room.connection.isOpen) return undefined
        localTick = tick
        const intent = input.sample()
        const controller = prediction.predicted?.controller
        if (intent.portalPressed && controller) {
          const portal = findOverlappingPortal(scene.map, controller.position)
          if (portal) {
            const requestId = ++scene.requestId
            travel = { source: scene, requestId, until: performance.now() + transferWaitMilliseconds }
            stopInput(scene)
            publishStatus('正在傳送…')
            room.send(interactPortalMessage, { requestId, mapEpoch: binding.mapEpoch, objectId: portal.id })
            return undefined
          }
        }
        const frame = prediction.step(intent, tick)
        if (frame) room.send(inputFrameMessage, frame)
        else {
          driver = undefined
          scene.correction.reset()
          input.clearForRoomChange()
          if (diagnostics) host.dataset.predictionOverflows = String(prediction.diagnostics.historyOverflows)
        }
        return undefined
      },
      localTick
    )
  }

  const timer = setInterval(() => {
    const now = performance.now()
    if (travel && now >= travel.until) failTravel(travel, '傳送逾時，請重新按 ↑。', true)
    if (recovery) {
      if (now >= recovery.until) disconnect()
      else if (!awaiting && !connectingRecovery && now >= recovery.nextAttempt) void tryReconnect(recovery)
      return
    }
    startClock()
    driver?.advance()
  }, 500 / ticksPerSecond)

  document.addEventListener(
    'visibilitychange',
    () => {
      if (active) stopInput(active)
    },
    { signal }
  )

  const draw = (now: number) => {
    animation = requestAnimationFrame(draw)
    const scene = active
    const self = scene?.prediction?.predicted
    if (!scene?.latest || !self) return
    const { controller, tick } = self
    const { hp, maxHp, state: authoritativeState, spawnProtected } = scene.latest.self
    const state = authoritativeState === 'death' ? 'death' : getPlayerPresentationState(controller)
    const facing = controller.action.kind === 'attack' ? controller.action.facing : controller.facing
    const position = scene.correction.positionAt(controller.position, now)
    const { peers, monsters } = scene.remote.sample(now)
    renderer.render({
      position,
      state,
      facing,
      visualTick: state === 'death' ? scene.latest.serverTick : tick,
      map: scene.map,
      peers,
      monsters,
      damage: scene.combat.sample(now),
    })
    if (diagnostics) {
      const peer = peers.values().next().value
      const trace = peer ? JSON.stringify({ ...peer.position, tick: peer.visualTick, mode: peer.mode }) : ''
      if (host.dataset.remoteFrame !== trace) host.dataset.remoteFrame = trace
      const predictedX = String(controller.position.x)
      if (host.dataset.localPredictedX !== predictedX) host.dataset.localPredictedX = predictedX
      const damageSeen = String(scene.combat.receivedCount())
      if (host.dataset.combatDamageSeen !== damageSeen) host.dataset.combatDamageSeen = damageSeen
    }
    const players = peers.size + 1
    if (
      players !== previous?.players ||
      hp !== previous.hp ||
      maxHp !== previous.maxHp ||
      spawnProtected !== previous.spawnProtected ||
      state !== previous.state ||
      facing !== previous.facing
    ) {
      const mapName = data.world.maps.find(({ id }) => id === scene.map.id)?.name ?? scene.map.id
      previous = { hp, maxHp, state, facing, players, mapName, spawnProtected }
      publish(previous)
    }
  }
  let animation = requestAnimationFrame(draw)
  signal.addEventListener(
    'abort',
    () => {
      cancelAnimationFrame(animation)
      clearInterval(timer)
      if (active) release(active)
      if (awaiting) release(awaiting)
      clearDiagnostics()
    },
    { once: true }
  )

  const room = await client.joinOrCreate<MapRoomState>(mapRoomName, version, MapRoomSchema)
  if (signal.aborted) {
    await room.leave()
    return
  }
  attachRoom(room, { roomId: room.roomId, mapId: 'm1', mapEpoch: 0 })
}
