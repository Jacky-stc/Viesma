import { Client, type Room } from '@colyseus/sdk'
import { toSimulationTick, type Attributes, type EquipmentOperation, type ItemDefinitionId } from '@viesma/domain'
import {
  initialEncounterRewardBalance,
  initialPhysicsBalance,
  loadGrayboxGameData,
  serializeMapManifest,
  type ItemDefinition,
  type NormalizedMap,
} from '@viesma/game-data'
import { MapRoomSchema, readPublicMonsters, readPublicPlayers, type MapRoomState } from '@viesma/network-colyseus'
import {
  allocateApMessage,
  cancelTransferMessage,
  combatDamageMessage,
  consumeItemMessage,
  equipmentMessage,
  inputFrameMessage,
  interactPortalMessage,
  mapRoomJoinedMessage,
  mapRoomName,
  movementCheckpointMessage,
  ownerGroundLootMessage,
  ownerInventoryMessage,
  ownerLootCommandResultMessage,
  ownerProgressionMessage,
  parseMapRoomSession,
  parseMovementCheckpoint,
  parseOwnerGroundLoot,
  parseOwnerInventory,
  parseOwnerLootCommandResult,
  parseOwnerProgression,
  parseTransferFailure,
  parseTransferOffer,
  pickupLootMessage,
  PROTOCOL_VERSION,
  refreshGroundLootMessage,
  transferFailureMessage,
  transferOfferMessage,
  type AllocateApRequest,
  type ApResultCode,
  type EquipmentRequest,
  type EquipmentResultCode,
  type GroundLootOperation,
  type GroundLootRequest,
  type LootResultCode,
  type MapRoomSession,
  type OnlineMapId,
  type OwnerInventory,
  type OwnerProgression,
  type PublicPlayer,
  type TransferOffer,
} from '@viesma/protocol'
import {
  createFixedTickDriver,
  findOverlappingPortal,
  getPlayerPresentationState,
  ticksPerSecond,
  type FixedTickDriver,
  type PlayerControllerState,
} from '@viesma/simulation'
import { attachBrowserInput } from '../input/browser-input'
import { createWorldRenderer } from '../rendering/world-renderer'
import { createCombatPresentation } from './combat-presentation'
import { createCorrectionPresentation } from './correction-presentation'
import { createLocalPrediction } from './local-prediction'
import { createOwnerLootView, matchesOwnerLoot } from './owner-loot-view'
import { createRemotePresentation } from './remote-presentation'

export type MultiplayerPresentation = Pick<PublicPlayer, 'hp' | 'maxHp' | 'state' | 'facing' | 'spawnProtected'> & {
  readonly players: number
  readonly mapName: string
  readonly progression: OwnerProgression | undefined
  readonly inventory: OwnerInventory | undefined
  readonly items: readonly ItemDefinition[]
  readonly equipmentStatus: 'PENDING' | EquipmentResultCode | undefined
  readonly pickupStatus: LootResultCode | undefined
  readonly consumeStatus: LootResultCode | undefined
  readonly changeEquipment: (operation: EquipmentOperation, snapshot: OwnerInventory) => boolean
  readonly apStatus: 'PENDING' | ApResultCode | undefined
  readonly allocateAp: (deltas: Attributes, snapshot: OwnerProgression) => boolean
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
  readonly groundLoot: ReturnType<typeof createOwnerLootView>
  binding?: MapRoomSession
  progression?: OwnerProgression
  inventory?: OwnerInventory
  apStatus?: 'PENDING' | ApResultCode
  equipmentStatus?: 'PENDING' | EquipmentResultCode
  pickupStatus?: LootResultCode
  consumeStatus?: LootResultCode
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

function traceController(controller: PlayerControllerState | undefined) {
  if (!controller) return null
  const { position, physics, movement, action, lastHurtTick } = controller
  return { x: position.x, y: position.y, vy: physics.velocity.y, grounded: physics.grounded, action, movement, lastHurtTick }
}

type SmokeMovementRecord =
  | { kind: 'snapshot'; serverTick: number; accepted: boolean; player: PublicPlayer | null }
  | (RoomLocation & {
      kind: 'checkpoint'
      connectionEpoch: string
      serverTick: number
      ackInputSeq: number | null
      result: string
      controller: ReturnType<typeof traceController>
      predictedX: number | null
      pendingInputs: number
      replayedInputs: number
    })
  | {
      kind: 'portal-edge'
      roomId: string
      mapEpoch: number
      localTick: number
      inputSeq: number | null
      portalId: string | null
      x: number
    }
  | { kind: 'transfer-offer'; requestId: number | null; sourceRoomId: string; destination: RoomLocation }
  | {
      kind: 'input'
      localTick: number
      predictedTick: number | null
      inputSeq: number | null
      mapEpoch: number
      moveX: number
      jumpPressed: boolean
      controller: ReturnType<typeof traceController>
    }
  | { kind: 'jump-sent'; localTick: number; inputSeq: number; mapEpoch: number }
  | { kind: 'render'; rafMs: number; serverTick: number | null; y: number | null; visualTick: number | null; mode: string | null }

type SmokeMovementObserver = { targetCharacterId?: string; record(event: SmokeMovementRecord): void }

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
  toggleApPanel: () => void,
  toggleInventory: () => void,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return
  const document = host.ownerDocument
  const diagnostics = new URLSearchParams(document.location.search).get('multiplayerDiagnostics') === '1'
  // 僅由瀏覽器測試夾具在頁面初始化前安裝，資料留在頁內。
  const smokeTrace = diagnostics
    ? (document.defaultView as (Window & { __viesmaMovementSmoke?: SmokeMovementObserver }) | null)?.__viesmaMovementSmoke
    : undefined
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
  let latestCharacterVersion = -1
  let latestInventoryVersion = -1
  let economyRequestId = 0
  let pendingAp: AllocateApRequest | undefined
  let pendingEquipment: EquipmentRequest | undefined
  const pendingLoot = new Map<GroundLootOperation['kind'], GroundLootRequest>()

  function canSend(scene: RoomScene, binding: MapRoomSession, snapshot: OwnerProgression | OwnerInventory): boolean {
    return (
      !travel &&
      !recovery &&
      scene.room.connection.isOpen &&
      scene.latest?.self.state !== 'death' &&
      snapshot.connectionEpoch === binding.connectionEpoch &&
      snapshot.mapEpoch === binding.mapEpoch
    )
  }

  function allocateAp(deltas: Attributes, snapshot: OwnerProgression): boolean {
    const scene = active
    const binding = scene?.binding
    if (!scene || !binding || pendingAp || !canSend(scene, binding, snapshot)) return false
    pendingAp = {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch: binding.connectionEpoch,
      mapEpoch: binding.mapEpoch,
      requestEpoch: binding.connectionEpoch,
      expectedCharacterVersion: snapshot.characterVersion,
      requestId: ++economyRequestId,
      deltas,
    }
    scene.apStatus = 'PENDING'
    scene.room.send(allocateApMessage, pendingAp)
    return true
  }

  function changeEquipment(operation: EquipmentOperation, snapshot: OwnerInventory): boolean {
    const scene = active
    const binding = scene?.binding
    if (!scene || !binding || pendingEquipment || !canSend(scene, binding, snapshot)) return false
    pendingEquipment = {
      ...operation,
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch: binding.connectionEpoch,
      mapEpoch: binding.mapEpoch,
      requestEpoch: binding.connectionEpoch,
      expectedCharacterVersion: snapshot.characterVersion,
      requestId: ++economyRequestId,
    }
    scene.equipmentStatus = 'PENDING'
    scene.room.send(equipmentMessage, pendingEquipment)
    return true
  }

  function sendLootRequest(scene: RoomScene, request: GroundLootRequest) {
    const { binding } = scene
    if (!binding) return
    const { kind, ...payload } = request
    scene.room.send(kind === 'pickup' ? pickupLootMessage : consumeItemMessage, {
      ...payload,
      connectionEpoch: binding.connectionEpoch,
      mapEpoch: binding.mapEpoch,
    })
  }

  function requestLootAction(scene: RoomScene, action: 'pickup' | 'hpPotion' | 'mpPotion', controller: PlayerControllerState) {
    const kind = action === 'pickup' ? 'pickup' : 'consume'
    const { binding, inventory } = scene
    if (!binding || !inventory || pendingLoot.has(kind) || !canSend(scene, binding, inventory)) return
    let operation: GroundLootOperation
    if (kind === 'pickup') {
      const x = controller.position.x + initialPhysicsBalance.bodyWidthWorldUnits / 2
      const y = controller.position.y + initialPhysicsBalance.bodyHeightWorldUnits
      const distance = ({ position }: { position: { x: number; y: number } }) => (x - position.x) ** 2 + (y - position.y) ** 2
      const radius = initialEncounterRewardBalance.lootPickupRadiusWorldUnits
      const nearest = [...scene.groundLoot.loot().values()].sort(
        (a, b) => distance(a) - distance(b) || (a.lootId < b.lootId ? -1 : Number(a.lootId > b.lootId))
      )[0]
      if (!nearest || distance(nearest) > radius ** 2) {
        scene.pickupStatus = 'LOOT_UNAVAILABLE'
        return
      }
      scene.pickupStatus = 'PENDING'
      operation = { kind, lootId: nearest.lootId }
    } else {
      const itemDefinitionId = (action === 'hpPotion' ? 'hp_potion' : 'mp_potion') as ItemDefinitionId
      const bagSlot = inventory.bag.findIndex((item) => item?.itemDefinitionId === itemDefinitionId && item.quantity > 0)
      if (bagSlot < 0) {
        scene.consumeStatus = 'SOURCE_CHANGED'
        return
      }
      scene.consumeStatus = 'PENDING'
      operation = { kind, itemDefinitionId, bagSlot }
    }
    const request: GroundLootRequest = {
      ...operation,
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch: binding.connectionEpoch,
      mapEpoch: binding.mapEpoch,
      requestEpoch: binding.connectionEpoch,
      expectedCharacterVersion: inventory.characterVersion,
      requestId: ++economyRequestId,
    }
    pendingLoot.set(kind, request)
    sendLootRequest(scene, request)
  }

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
    const binding = scene.binding
    if (binding) {
      const { connectionEpoch, mapEpoch } = binding
      if (pendingAp && pendingAp.connectionEpoch !== connectionEpoch) {
        scene.apStatus = 'PENDING'
        scene.room.send(allocateApMessage, { ...pendingAp, connectionEpoch, mapEpoch })
      }
      if (pendingEquipment && pendingEquipment.connectionEpoch !== connectionEpoch) {
        scene.equipmentStatus = 'PENDING'
        scene.room.send(equipmentMessage, { ...pendingEquipment, connectionEpoch, mapEpoch })
      }
      for (const request of pendingLoot.values()) {
        if (request.connectionEpoch === connectionEpoch) continue
        if (request.kind === 'pickup') scene.pickupStatus = 'PENDING'
        else scene.consumeStatus = 'PENDING'
        sendLootRequest(scene, request)
      }
    }
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
      groundLoot: createOwnerLootView(),
      requestId: 0,
      detach: () => {
        unbindJoin()
        unbindCheckpoint()
        unbindCombatDamage()
        unbindProgression()
        unbindInventory()
        unbindGroundLoot()
        unbindLootResult()
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
      const accepted = scene.remote.receive(
        { mapInstanceId, mapId, connectionEpoch: binding.connectionEpoch, mapEpoch: self.mapEpoch },
        serverTick,
        performance.now(),
        peers,
        monsters
      )
      if (smokeTrace?.targetCharacterId)
        smokeTrace.record({
          kind: 'snapshot',
          serverTick,
          accepted,
          player: players.find((p) => p.characterId === smokeTrace.targetCharacterId) ?? null,
        })
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
    const unbindProgression = room.onMessage(ownerProgressionMessage, (payload: unknown) => {
      const { binding } = scene
      if (!isCurrent() || !binding || (recovery && active === scene)) return
      const update = parseOwnerProgression(payload)
      if (
        !update ||
        update.characterId !== binding.characterId ||
        update.connectionEpoch !== binding.connectionEpoch ||
        update.mapEpoch !== binding.mapEpoch
      )
        return
      if (update.characterVersion >= latestCharacterVersion && scene.progression?.characterVersion !== update.characterVersion) {
        latestCharacterVersion = update.characterVersion
        scene.progression = update
      }
      const { result } = update
      if (result && pendingAp && result.requestId === pendingAp.requestId && result.requestEpoch === pendingAp.requestEpoch) {
        pendingAp = undefined
        scene.apStatus = result.code
      }
    })
    const unbindInventory = room.onMessage(ownerInventoryMessage, (payload: unknown) => {
      const { binding } = scene
      if (!isCurrent() || !binding || (recovery && active === scene)) return
      const update = parseOwnerInventory(payload)
      if (
        !update ||
        update.characterId !== binding.characterId ||
        update.connectionEpoch !== binding.connectionEpoch ||
        update.mapEpoch !== binding.mapEpoch
      )
        return
      if (update.characterVersion >= latestInventoryVersion && scene.inventory?.characterVersion !== update.characterVersion) {
        latestInventoryVersion = update.characterVersion
        scene.inventory = update
      }
      const { result } = update
      if (
        result &&
        pendingEquipment &&
        result.requestId === pendingEquipment.requestId &&
        result.requestEpoch === pendingEquipment.requestEpoch
      ) {
        pendingEquipment = undefined
        scene.equipmentStatus = result.code
      }
    })
    const unbindGroundLoot = room.onMessage(ownerGroundLootMessage, (payload: unknown) => {
      const { binding, latest } = scene
      if (!isCurrent() || !binding || !latest || (recovery && active === scene)) return
      const update = parseOwnerGroundLoot(payload)
      if (!update || !matchesOwnerLoot(update, binding, latest.mapInstanceId)) return
      if (scene.groundLoot.receive(update))
        room.send(refreshGroundLootMessage, {
          protocolVersion: PROTOCOL_VERSION,
          characterId: binding.characterId,
          connectionEpoch: binding.connectionEpoch,
          mapEpoch: binding.mapEpoch,
          mapInstanceId: latest.mapInstanceId,
        })
    })
    const unbindLootResult = room.onMessage(ownerLootCommandResultMessage, (payload: unknown) => {
      const { binding, latest } = scene
      if (!isCurrent() || !binding || !latest || (recovery && active === scene)) return
      const result = parseOwnerLootCommandResult(payload)
      if (!result || !matchesOwnerLoot(result, binding, latest.mapInstanceId)) return
      const pending = pendingLoot.get(result.kind)
      if (!pending || result.requestId !== pending.requestId || result.requestEpoch !== pending.requestEpoch) return
      if (result.code !== 'PENDING') pendingLoot.delete(result.kind)
      if (result.kind === 'pickup') scene.pickupStatus = result.code
      else scene.consumeStatus = result.code
    })
    const unbindCheckpoint = room.onMessage(movementCheckpointMessage, (payload: unknown) => {
      const { binding, latest, correction } = scene
      if (!isCurrent() || !binding || !latest) return
      const checkpoint = parseMovementCheckpoint(payload)
      if (!checkpoint || checkpoint.serverTick > latest.serverTick || checkpoint.mapEpoch !== binding.mapEpoch) return
      const prediction = (scene.prediction ??= createLocalPrediction(map, latest.mapInstanceId, binding))
      const before = prediction.predicted?.controller.position
      const result = prediction.receive(checkpoint)
      if (smokeTrace?.targetCharacterId === binding.characterId)
        smokeTrace.record({
          kind: 'checkpoint',
          roomId: location.roomId,
          mapId: location.mapId,
          mapEpoch: location.mapEpoch,
          connectionEpoch: binding.connectionEpoch,
          serverTick: checkpoint.serverTick,
          ackInputSeq: checkpoint.ackInputSeq,
          result,
          controller: traceController(checkpoint.controller),
          predictedX: prediction.predicted?.controller.position.x ?? null,
          pendingInputs: prediction.diagnostics.pendingInputs,
          replayedInputs: prediction.diagnostics.replayedInputs,
        })
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
      if (smokeTrace?.targetCharacterId === binding.characterId)
        smokeTrace.record({
          kind: 'transfer-offer',
          requestId: offer.requestId,
          sourceRoomId: location.roomId,
          destination: { roomId: offer.roomId, mapId: offer.mapId, mapEpoch: offer.mapEpoch },
        })
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
        if (intent.actions.includes('ap')) toggleApPanel()
        if (intent.actions.includes('inventory')) toggleInventory()
        const controller = prediction.predicted?.controller
        if (intent.portalPressed && controller) {
          const portal = findOverlappingPortal(scene.map, controller.position)
          if (smokeTrace?.targetCharacterId === binding.characterId)
            smokeTrace.record({
              kind: 'portal-edge',
              roomId: room.roomId,
              mapEpoch: binding.mapEpoch,
              localTick: tick,
              inputSeq: controller.movement.lastProcessedInputSeq,
              portalId: portal?.id ?? null,
              x: controller.position.x,
            })
          if (portal) {
            const requestId = ++scene.requestId
            travel = { source: scene, requestId, until: performance.now() + transferWaitMilliseconds }
            stopInput(scene)
            publishStatus('正在傳送…')
            room.send(interactPortalMessage, { requestId, mapEpoch: binding.mapEpoch, objectId: portal.id })
            return undefined
          }
        }
        if (controller)
          for (const action of intent.actions) {
            if (action === 'pickup' || action === 'hpPotion' || action === 'mpPotion') requestLootAction(scene, action, controller)
          }
        const frame = prediction.step(intent, tick)
        const trace = smokeTrace?.targetCharacterId === binding.characterId ? smokeTrace : undefined
        if (trace)
          trace.record({
            kind: 'input',
            localTick: tick,
            predictedTick: prediction.predicted?.tick ?? null,
            inputSeq: frame?.seq ?? null,
            mapEpoch: binding.mapEpoch,
            moveX: intent.moveX,
            jumpPressed: intent.jumpPressed,
            controller: traceController(prediction.predicted?.controller),
          })
        if (frame) {
          room.send(inputFrameMessage, frame)
          if (frame.jumpPressed) trace?.record({ kind: 'jump-sent', localTick: tick, inputSeq: frame.seq, mapEpoch: frame.mapEpoch })
        } else {
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
      groundLoot: !travel && !recovery ? scene.groundLoot.loot() : undefined,
    })
    if (smokeTrace?.targetCharacterId) {
      const target = peers.get(smokeTrace.targetCharacterId)
      smokeTrace.record({
        kind: 'render',
        rafMs: now,
        serverTick: scene.latest.serverTick,
        y: target?.position.y ?? null,
        visualTick: target?.visualTick ?? null,
        mode: target?.mode ?? null,
      })
    }
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
    const { apStatus, equipmentStatus, pickupStatus, consumeStatus } = scene
    if (
      players !== previous?.players ||
      hp !== previous.hp ||
      maxHp !== previous.maxHp ||
      spawnProtected !== previous.spawnProtected ||
      state !== previous.state ||
      facing !== previous.facing ||
      scene.progression !== previous.progression ||
      apStatus !== previous.apStatus ||
      scene.inventory !== previous.inventory ||
      equipmentStatus !== previous.equipmentStatus ||
      pickupStatus !== previous.pickupStatus ||
      consumeStatus !== previous.consumeStatus
    ) {
      const mapName = data.world.maps.find(({ id }) => id === scene.map.id)?.name ?? scene.map.id
      previous = {
        hp,
        maxHp,
        state,
        facing,
        players,
        mapName,
        spawnProtected,
        progression: scene.progression,
        apStatus,
        allocateAp,
        inventory: scene.inventory,
        items: data.items,
        equipmentStatus,
        pickupStatus,
        consumeStatus,
        changeEquipment,
      }
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
