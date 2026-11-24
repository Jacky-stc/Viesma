import { CloseCode, ErrorCode, getMessageBytes, matchMaker, Protocol, Room, ServerError, type Client } from '@colyseus/core'
import { MapRoomSchema, updateMapRoomSchema, type MapRoomState } from '@viesma/network-colyseus'
import {
  cancelTransferMessage,
  checkJoinVersion,
  inputFrameMessage,
  interactPortalMessage,
  mapRoomJoinedMessage,
  mapRoomName,
  movementCheckpointMessage,
  parseMapAdmission,
  parseTransferCancellation,
  transferFailureMessage,
  transferOfferMessage,
  villageMapRoomName,
  type JoinVersion,
  type MapRoomSession,
  type OnlineMapId,
  type TransferOffer,
} from '@viesma/protocol'
import { mapRoomCapacity, type MapRuntime } from '../runtime/map-runtime.ts'
import type { RoomPeer, WorldCoordinator } from '../runtime/world-coordinator.ts'

export function createDestinationRoom(mapId: OnlineMapId) {
  return matchMaker.createRoom(mapId === 'village' ? villageMapRoomName : mapRoomName, {})
}

function sendCredential(client: Client, message: string, payload: MapRoomSession | TransferOffer): void {
  // WebSocketClient.send 的 debug 模式會輸出 payload。
  client.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA, message, payload))
}

export function createMapRoomClass(world: WorldCoordinator, version: JoinVersion, reservationSeconds = 15, mapId: OnlineMapId = 'm1') {
  return class MapRoom extends Room<{ state: MapRoomState }> {
    maxClients = mapRoomCapacity
    patchRate = 100
    seatReservationTimeout = reservationSeconds
    #runtime: MapRuntime | undefined

    onCreate(): void {
      const runtime = world.createRoom(mapId, this.roomId)
      this.#runtime = runtime
      this.state = new MapRoomSchema()
      updateMapRoomSchema(this.state, runtime.snapshot())
      this.onMessage(inputFrameMessage, (client, payload: unknown) => {
        if (this.clients.getById(client.sessionId) === client) {
          world.receive(runtime, client, payload)
        }
      })
      this.onMessage(interactPortalMessage, (client, payload: unknown) => {
        world.requestPortal(runtime, client, payload)
      })
      this.onMessage(cancelTransferMessage, (client, payload: unknown) => {
        const ticket = parseTransferCancellation(payload)
        if (ticket) world.cancelTransfer(runtime, client, ticket)
      })
    }

    onAuth(_client: Client, options: unknown): true {
      const result = checkJoinVersion(version, options)
      if (!result.ok) throw new ServerError(ErrorCode.AUTH_FAILED, result.code)
      if (!world.canAdmit()) throw new ServerError(ErrorCode.AUTH_FAILED, 'WORLD_TICK_BACKLOG')
      return true
    }

    onJoin(client: Client, options: unknown): void {
      const admission = parseMapAdmission(options)
      const runtime = this.#runtime
      if (!runtime || !admission) throw new ServerError(ErrorCode.AUTH_FAILED, 'MAP_ADMISSION_INVALID')
      const peer: RoomPeer = {
        connection: client,
        joined: (binding) => sendCredential(client, mapRoomJoinedMessage, binding),
        offer: (offer) => sendCredential(client, transferOfferMessage, offer),
        failed: (failure) => client.send(transferFailureMessage, failure),
        close: () => {
          if (this.clients.getById(client.sessionId) === client) this.kickClient(client.sessionId)
        },
      }
      if (!world.canAdmit()) throw new ServerError(ErrorCode.AUTH_FAILED, 'WORLD_TICK_BACKLOG')
      if (admission.kind === 'transfer' && world.acceptTransfer(runtime, peer, admission.ticket, admission.reconnectToken)) return
      if (admission.kind === 'reconnect' && world.reconnect(runtime, peer, admission.reconnectToken)) {
        this.autoDispose = !runtime.hasRetainedSeats()
        return
      }
      if (admission.kind !== 'fresh' || mapId !== 'm1') throw new ServerError(ErrorCode.AUTH_FAILED, 'MAP_ADMISSION_INVALID')
      if (!world.join(runtime, peer)) throw new ServerError(ErrorCode.MATCHMAKE_INVALID_CRITERIA, 'MAP_SEAT_UNAVAILABLE')
    }

    onLeave(client: Client): void {
      const runtime = this.#runtime
      if (!runtime) return
      world.leave(runtime, client)
      this.autoDispose = !runtime.hasRetainedSeats()
    }

    onDrop(client: Client, code?: number): void {
      const runtime = this.#runtime
      if (!runtime) return
      const reconnectable =
        code === CloseCode.NO_STATUS_RECEIVED ||
        code === CloseCode.ABNORMAL_CLOSURE ||
        code === CloseCode.GOING_AWAY ||
        code === CloseCode.MAY_TRY_RECONNECT
      world.leave(runtime, client, reconnectable)
      this.autoDispose = !runtime.hasRetainedSeats()
    }

    onBeforePatch(): void {
      const runtime = this.#runtime
      if (!runtime) return
      this.autoDispose = !runtime.hasRetainedSeats()
      const snapshot = runtime.snapshot()
      if (snapshot.serverTick === this.state.serverTick) return
      updateMapRoomSchema(this.state, snapshot)
      for (const client of this.clients) {
        const checkpoint = world.checkpoint(runtime, client)
        if (checkpoint) client.send(movementCheckpointMessage, checkpoint, { afterNextPatch: true })
      }
    }

    onDispose(): void {
      if (this.#runtime) world.disposeRoom(this.#runtime)
      this.#runtime = undefined
    }
  }
}
