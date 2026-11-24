import { Server } from '@colyseus/core'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { mapRoomName, PROTOCOL_VERSION, villageMapRoomName, type JoinVersion } from '@viesma/protocol'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createDestinationRoom, createMapRoomClass } from './adapters/map-room.ts'
import { createWorldCoordinator } from './runtime/world-coordinator.ts'

const host = '127.0.0.1'
const port = Number(process.env.VIESMA_SERVER_PORT ?? 2567)

const gameData = loadGrayboxGameData()
const version: JoinVersion = {
  protocolVersion: PROTOCOL_VERSION,
  balanceVersion: gameData.balanceVersion,
  mapContentHash: createHash('sha256').update(serializeMapManifest(gameData), 'utf8').digest('hex'),
}
console.info('Viesma game data validated', version)

const world = createWorldCoordinator(gameData, version.mapContentHash, {
  clock: { nowMilliseconds: () => performance.now() },
  schedule(wake, intervalMilliseconds) {
    const timer = setInterval(wake, intervalMilliseconds)
    return () => clearInterval(timer)
  },
  nextId: randomUUID,
  createDestination: createDestinationRoom,
  onBacklog: (backlogTicks) => console.warn('Viesma world tick backlog', { backlogTicks }),
  onBacklogRecovered: (recoveryMilliseconds, catchUpTicks) =>
    console.info('Viesma world tick backlog recovered', { recoveryMilliseconds, catchUpTicks }),
})
const server = new Server({ transport: new WebSocketTransport({ maxPayload: 4096 }), greet: false })
server.define(mapRoomName, createMapRoomClass(world, version))
server.define(villageMapRoomName, createMapRoomClass(world, version, 15, 'village'))
await server.listen(port, host)

console.info(`Viesma server listening at http://${host}:${port}`)
