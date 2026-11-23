import { ErrorCode, Room, ServerError, type Client } from '@colyseus/core'
import { MapRoomSchema, updateMapRoomSchema, type MapRoomState } from '@viesma/network-colyseus'
import { checkJoinVersion, inputFrameMessage, mapRoomJoinedMessage, movementCheckpointMessage, type JoinVersion } from '@viesma/protocol'
import { mapRoomCapacity, type MapRuntime } from '../runtime/map-runtime.ts'
import type { WorldCoordinator } from '../runtime/world-coordinator.ts'

export function createMapRoomClass(world: WorldCoordinator, version: JoinVersion, reservationSeconds = 15) {
  return class MapRoom extends Room<{ state: MapRoomState }> {
    maxClients = mapRoomCapacity
    patchRate = 100
    seatReservationTimeout = reservationSeconds
    #runtime: MapRuntime | undefined

    onCreate(): void {
      const runtime = world.createRoom()
      this.#runtime = runtime
      this.state = new MapRoomSchema()
      updateMapRoomSchema(this.state, runtime.snapshot())
      this.onMessage(inputFrameMessage, (client, payload: unknown) => {
        if (this.clients.getById(client.sessionId) === client) {
          runtime.receive(client, payload, world.clock.nowMilliseconds())
        }
      })
    }

    onAuth(_client: Client, options: unknown): true {
      const result = checkJoinVersion(version, options)
      if (!result.ok) throw new ServerError(ErrorCode.AUTH_FAILED, result.code)
      if (!world.canAdmit()) throw new ServerError(ErrorCode.AUTH_FAILED, 'WORLD_TICK_BACKLOG')
      return true
    }

    onJoin(client: Client): void {
      const binding = this.#runtime?.join(client, world.clock.nowMilliseconds())
      if (!binding) throw new ServerError(ErrorCode.MATCHMAKE_INVALID_CRITERIA, 'MAP_SEAT_UNAVAILABLE')
      client.send(mapRoomJoinedMessage, binding)
    }

    onLeave(client: Client): void {
      this.#runtime?.leave(client)
    }

    onBeforePatch(): void {
      const runtime = this.#runtime
      if (!runtime) return
      const snapshot = runtime.snapshot()
      if (snapshot.serverTick === this.state.serverTick) return
      updateMapRoomSchema(this.state, snapshot)
      for (const client of this.clients) {
        const checkpoint = runtime.checkpoint(client)
        if (checkpoint) client.send(movementCheckpointMessage, checkpoint, { afterNextPatch: true })
      }
    }

    onDispose(): void {
      if (this.#runtime) world.disposeRoom(this.#runtime)
      this.#runtime = undefined
    }
  }
}
