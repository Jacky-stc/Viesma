import { ClientState, CloseCode, ErrorCode, getMessageBytes, matchMaker, Protocol, Room, ServerError, type Client } from '@colyseus/core'
import { MapRoomSchema, updateMapRoomSchema, type MapRoomState } from '@viesma/network-colyseus'
import {
  allocateApMessage,
  cancelTransferMessage,
  checkJoinVersion,
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
  parseMapAdmission,
  parseTransferCancellation,
  pickupLootMessage,
  refreshGroundLootMessage,
  transferFailureMessage,
  transferOfferMessage,
  villageMapRoomName,
  type JoinVersion,
  type MapRoomSession,
  type OnlineMapId,
  type TransferOffer,
} from '@viesma/protocol'
import { mapRoomCapacity, type MapRuntime } from '../runtime/map-runtime.ts'
import type { GroundLootFeed, RoomPeer, WorldCoordinator } from '../runtime/world-coordinator.ts'

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
    #combatReady = new WeakSet<Client>()
    #progressionVersion = new WeakMap<Client, number>()
    #inventoryVersion = new WeakMap<Client, number>()
    #lootFeed = new WeakMap<Client, GroundLootFeed>()
    #lootRefresh = new WeakMap<Client, unknown>()

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
      this.onMessage(allocateApMessage, (client, payload: unknown) => {
        if (this.clients.getById(client.sessionId) === client) world.requestAp(runtime, client, payload)
      })
      this.onMessage(equipmentMessage, (client, payload: unknown) => {
        if (this.clients.getById(client.sessionId) === client) world.requestEquipment(runtime, client, payload)
      })
      this.onMessage(pickupLootMessage, (client, payload: unknown) => {
        if (this.clients.getById(client.sessionId) === client) world.requestGroundLoot(runtime, client, payload, 'pickup')
      })
      this.onMessage(consumeItemMessage, (client, payload: unknown) => {
        if (this.clients.getById(client.sessionId) === client) world.requestGroundLoot(runtime, client, payload, 'consume')
      })
      this.onMessage(refreshGroundLootMessage, (client, payload: unknown) => {
        if (this.clients.getById(client.sessionId) === client) this.#lootRefresh.set(client, payload)
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
        progression: (snapshot) => {
          client.send(ownerProgressionMessage, snapshot)
          this.#progressionVersion.set(client, snapshot.characterVersion)
        },
        inventory: (snapshot) => {
          client.send(ownerInventoryMessage, snapshot)
          this.#inventoryVersion.set(client, snapshot.characterVersion)
        },
        lootResult: (result) => client.send(ownerLootCommandResultMessage, result),
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
      const previousTick = this.state.serverTick
      if (snapshot.serverTick === previousTick) return
      updateMapRoomSchema(this.state, snapshot)
      const combatDamage = runtime.combatDamageSince(previousTick)
      for (const client of this.clients) {
        if (client.state !== ClientState.JOINED) continue
        const checkpoint = world.checkpoint(runtime, client)
        if (!checkpoint) continue
        client.send(movementCheckpointMessage, checkpoint, { afterNextPatch: true })
        const progression = world.progression(runtime, client, this.#progressionVersion.get(client))
        if (progression) {
          client.send(ownerProgressionMessage, progression, { afterNextPatch: true })
          this.#progressionVersion.set(client, progression.characterVersion)
        }
        const inventory = world.inventory(runtime, client, this.#inventoryVersion.get(client))
        if (inventory) {
          client.send(ownerInventoryMessage, inventory, { afterNextPatch: true })
          this.#inventoryVersion.set(client, inventory.characterVersion)
        }
        const previousLoot = this.#lootFeed.get(client)
        const refresh = this.#lootRefresh.get(client)
        this.#lootRefresh.delete(client)
        const loot =
          (refresh === undefined ? undefined : world.ownerGroundLoot(runtime, client, previousLoot, refresh)) ??
          world.ownerGroundLoot(runtime, client, previousLoot)
        if (loot) {
          client.send(ownerGroundLootMessage, loot.update, { afterNextPatch: true })
          this.#lootFeed.set(client, loot.feed)
        }
        if (combatDamage && this.#combatReady.has(client)) {
          client.send(combatDamageMessage, combatDamage, { afterNextPatch: true })
        }
        this.#combatReady.add(client)
      }
    }

    onDispose(): void {
      if (this.#runtime) world.disposeRoom(this.#runtime)
      this.#runtime = undefined
    }
  }
}
