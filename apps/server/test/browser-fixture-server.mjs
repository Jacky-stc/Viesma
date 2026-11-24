import { matchMaker, Server } from '@colyseus/core'
import { Client } from '@colyseus/sdk'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { MapRoomSchema } from '@viesma/network-colyseus'
import { mapRoomJoinedMessage, mapRoomName, movementCheckpointMessage, PROTOCOL_VERSION } from '@viesma/protocol'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { clearInterval, setInterval } from 'node:timers'
import { URL } from 'node:url'
import { createMapRoomClass } from '../dist/adapters/map-room.js'
import { createWorldCoordinator } from '../dist/runtime/world-coordinator.js'

function joinVersion(data) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    balanceVersion: data.balanceVersion,
    mapContentHash: createHash('sha256').update(serializeMapManifest(data)).digest('hex'),
  }
}

export async function joinSmokePeer(baseURL) {
  const endpoint = new URL('/multiplayer', baseURL)
  const peer = await new Client(endpoint.href).joinOrCreate(mapRoomName, joinVersion(loadGrayboxGameData()), MapRoomSchema)
  peer.reconnection.enabled = false
  peer.onMessage(mapRoomJoinedMessage, () => {})
  peer.onMessage(movementCheckpointMessage, () => {})
  return peer
}

export async function startBrowserFixtureServer() {
  const data = loadGrayboxGameData()
  const version = joinVersion(data)
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
  const ownerAcks = new WeakMap()
  let room
  const MapRoom = createMapRoomClass(
    {
      ...world,
      createRoom() {
        room = world.createRoom()
        const checkpoint = room.checkpoint
        room.checkpoint = (connection) => {
          const result = checkpoint(connection)
          if (result) ownerAcks.set(connection, result.ackInputSeq)
          return result
        }
        return room
      },
    },
    version
  )
  server.define(mapRoomName, MapRoom)
  await server.listen(0, '127.0.0.1')
  const address = `127.0.0.1:${transport.server.address().port}`
  return {
    address,
    async reserve(options) {
      const seat = await matchMaker.joinOrCreate(mapRoomName, options)
      return { ...seat, publicAddress: address }
    },
    ownerAck({ roomId, sessionId }) {
      const connection = matchMaker.getLocalRoomById(roomId)?.clients.getById(sessionId)
      return connection && ownerAcks.get(connection)
    },
    queueFixtureEvent: (event) => room?.queueMonsterFixtureEvent(event),
    close: () => server.gracefullyShutdown(false),
  }
}
