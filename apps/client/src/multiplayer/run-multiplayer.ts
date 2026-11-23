import { Client } from '@colyseus/sdk'
import { toSimulationTick } from '@viesma/domain'
import { initialPhysicsBalance, loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { MapRoomSchema, readPublicMonsters, readPublicPlayers, type MapRoomState } from '@viesma/network-colyseus'
import {
  inputFrameMessage,
  mapRoomJoinedMessage,
  mapRoomName,
  movementCheckpointMessage,
  parseMapRoomJoin,
  parseMovementCheckpoint,
  PROTOCOL_VERSION,
  type MapRoomJoin,
  type PublicPlayer,
} from '@viesma/protocol'
import { createFixedTickDriver, getPlayerPresentationState, ticksPerSecond, type FixedTickDriver } from '@viesma/simulation'
import { attachBrowserInput } from '../input/browser-input'
import { mapNames } from '../playground/scene'
import { createWorldRenderer } from '../rendering/world-renderer'
import { createCorrectionPresentation } from './correction-presentation'
import { createLocalPrediction } from './local-prediction'
import { createRemotePresentation } from './remote-presentation'

export type MultiplayerPresentation = Pick<PublicPlayer, 'hp' | 'maxHp' | 'state' | 'facing'> & {
  readonly players: number
  readonly mapName: string
}

export async function runMultiplayer(
  host: HTMLElement,
  surface: HTMLElement,
  publish: (presentation: MultiplayerPresentation) => void,
  disconnect: () => void,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return
  const data = loadGrayboxGameData()
  const map = data.tiledMaps.find(({ id }) => id === 'm1')
  if (!map) throw new Error('Missing M1 map')
  const mapName = mapNames.get(map.id) ?? map.id
  const bytes = new TextEncoder().encode(serializeMapManifest(data))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const mapContentHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')

  const renderer = await createWorldRenderer(
    host,
    { width: initialPhysicsBalance.bodyWidthWorldUnits, height: initialPhysicsBalance.bodyHeightWorldUnits },
    signal
  )
  if (!renderer || signal.aborted) return

  const document = host.ownerDocument
  const endpoint = new URL('/multiplayer', document.location.href)
  const room = await new Client(endpoint.href).joinOrCreate<MapRoomState>(
    mapRoomName,
    { protocolVersion: PROTOCOL_VERSION, balanceVersion: data.balanceVersion, mapContentHash },
    MapRoomSchema
  )
  room.reconnection.enabled = false
  if (signal.aborted) {
    await room.leave()
    return
  }

  const input = attachBrowserInput(surface, signal)
  const correction = createCorrectionPresentation(map)
  const remote = createRemotePresentation()
  let binding: MapRoomJoin | undefined
  let prediction: ReturnType<typeof createLocalPrediction> | undefined
  let latest: { self: PublicPlayer; serverTick: number; mapInstanceId: string } | undefined
  let previous: MultiplayerPresentation | undefined
  let driver: FixedTickDriver | undefined
  let localTick = toSimulationTick(0)

  const receiveState = (state: MapRoomState) => {
    if (!binding || !state.mapId) return
    if (
      state.mapId !== map.id ||
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
    const characterId = binding.characterId
    const self = players.find((player) => player.characterId === characterId)
    if (!self) return
    const { serverTick, mapInstanceId, mapId } = state
    const peers = players.filter((player) => player !== self)
    const monsters = readPublicMonsters(state)
    remote.receive(
      { mapInstanceId, mapId, connectionEpoch: binding.connectionEpoch, mapEpoch: self.mapEpoch },
      serverTick,
      performance.now(),
      peers,
      monsters
    )
    latest = { self, serverTick, mapInstanceId }
    host.dataset.remoteSnapshotTick = String(serverTick)
    host.dataset.remoteAuthorityX = String(peers[0]?.x ?? '')
    host.dataset.sharedMonsters = JSON.stringify(monsters)
  }

  function startClock() {
    if (driver || document.hidden || !prediction?.ready) return
    driver = createFixedTickDriver(
      { nowMilliseconds: () => performance.now() },
      ({ tick }) => {
        localTick = tick
        if (!prediction?.ready || !room.connection.isOpen) return undefined
        const frame = prediction.step(input.sample(), tick)
        if (frame) room.send(inputFrameMessage, frame)
        else {
          driver = undefined
          correction.reset()
          input.clear()
          host.dataset.predictionOverflows = String(prediction.diagnostics.historyOverflows)
        }
        return undefined
      },
      localTick
    )
  }

  const unbindJoin = room.onMessage(mapRoomJoinedMessage, (payload: unknown) => {
    const joined = parseMapRoomJoin(payload)
    if (!joined) disconnect()
    else if (!binding) {
      binding = joined
      receiveState(room.state)
    }
  })
  const unbindCheckpoint = room.onMessage(movementCheckpointMessage, (payload: unknown) => {
    if (!binding || !latest) return
    const checkpoint = parseMovementCheckpoint(payload)
    if (!checkpoint || checkpoint.serverTick > latest.serverTick) return
    prediction ??= createLocalPrediction(map, latest.mapInstanceId, binding)
    const before = prediction.predicted?.controller.position
    const result = prediction.receive(checkpoint)
    const after = prediction.predicted?.controller.position
    if (result === 'ignored' || !after) return
    const { ackInputSeq, lastCorrectionWorldUnits, replayedInputs } = prediction.diagnostics
    let mode = result === 'reconciled' ? 'none' : 'snap'
    if (result === 'reconciled' && before) {
      if (lastCorrectionWorldUnits > 0) mode = correction.correct(before, after, performance.now()) ? 'smooth' : 'snap'
    } else {
      correction.reset()
      if (result === 'reset') input.clear()
    }
    // 供開發房診斷延遲及校正，無須讓 HUD 每 tick 更新。
    host.dataset.predictionAck = String(ackInputSeq ?? '')
    host.dataset.predictionReplayed = String(replayedInputs)
    if (mode !== 'none') {
      host.dataset.predictionCorrection = String(lastCorrectionWorldUnits)
      host.dataset.predictionCorrectionMode = mode
    }
    startClock()
  })
  room.onStateChange(receiveState)
  const onLeave = () => {
    if (!signal.aborted) disconnect()
  }
  room.onLeave(onLeave)

  const timer = setInterval(() => {
    if (!prediction?.ready || document.hidden || !room.connection.isOpen) {
      driver = undefined
      return
    }
    startClock()
    driver?.advance()
  }, 500 / ticksPerSecond)

  document.addEventListener(
    'visibilitychange',
    () => {
      driver = undefined
      prediction?.suspend()
      correction.reset()
    },
    { signal }
  )

  const draw = (now: number) => {
    animation = requestAnimationFrame(draw)
    const self = prediction?.predicted
    if (!latest || !self) return
    const { controller, tick } = self
    const state = getPlayerPresentationState(controller)
    const facing = controller.action.kind === 'attack' ? controller.action.facing : controller.facing
    const position = correction.positionAt(controller.position, now)
    const { peers, monsters } = remote.sample(now)
    renderer.render({ position, state, facing, visualTick: tick, map, peers, monsters })
    const peer = peers.values().next().value
    const trace = peer ? JSON.stringify({ x: peer.position.x, tick: peer.visualTick, mode: peer.mode }) : ''
    if (host.dataset.remoteFrame !== trace) host.dataset.remoteFrame = trace

    const { hp, maxHp } = latest.self
    const players = peers.size + 1
    if (
      players !== previous?.players ||
      hp !== previous.hp ||
      maxHp !== previous.maxHp ||
      state !== previous.state ||
      facing !== previous.facing
    ) {
      previous = { hp, maxHp, state, facing, players, mapName }
      publish(previous)
    }
  }
  let animation = requestAnimationFrame(draw)
  signal.addEventListener(
    'abort',
    () => {
      cancelAnimationFrame(animation)
      clearInterval(timer)
      unbindJoin()
      unbindCheckpoint()
      room.onStateChange.remove(receiveState)
      room.onLeave.remove(onLeave)
      prediction?.dispose()
      correction.reset()
      remote.clear()
      delete host.dataset.predictionAck
      delete host.dataset.predictionReplayed
      delete host.dataset.predictionCorrection
      delete host.dataset.predictionCorrectionMode
      delete host.dataset.predictionOverflows
      delete host.dataset.remoteSnapshotTick
      delete host.dataset.remoteAuthorityX
      delete host.dataset.sharedMonsters
      delete host.dataset.remoteFrame
      void room.leave()
    },
    { once: true }
  )
}
