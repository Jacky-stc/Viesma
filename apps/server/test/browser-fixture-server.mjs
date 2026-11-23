import { Server } from '@colyseus/core'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { mapRoomName, PROTOCOL_VERSION } from '@viesma/protocol'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { clearInterval, setInterval } from 'node:timers'
import { createMapRoomClass } from '../dist/adapters/map-room.js'
import { createWorldCoordinator } from '../dist/runtime/world-coordinator.js'

export async function startBrowserFixtureServer() {
  const data = loadGrayboxGameData()
  const version = {
    protocolVersion: PROTOCOL_VERSION,
    balanceVersion: data.balanceVersion,
    mapContentHash: createHash('sha256').update(serializeMapManifest(data)).digest('hex'),
  }
  const world = createWorldCoordinator(data, version.mapContentHash, {
    clock: { nowMilliseconds: () => performance.now() },
    nextId: randomUUID,
    onBacklog() {},
    schedule(wake, milliseconds) {
      const timer = setInterval(wake, milliseconds)
      return () => clearInterval(timer)
    },
  })
  const transport = new WebSocketTransport({ maxPayload: 4096 })
  const server = new Server({ transport, gracefullyShutdown: false, greet: false })
  let room
  server.define(
    mapRoomName,
    createMapRoomClass(
      {
        ...world,
        createRoom() {
          room = world.createRoom()
          return room
        },
      },
      version
    )
  )
  await server.listen(0, '127.0.0.1')
  return {
    address: `127.0.0.1:${transport.server.address().port}`,
    queueFixtureEvent: (event) => room?.queueMonsterFixtureEvent(event),
    close: () => server.gracefullyShutdown(false),
  }
}
