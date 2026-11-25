import { getMessageBytes, matchMaker, Protocol, Server } from '@colyseus/core'
import { Client } from '@colyseus/sdk'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { MapRoomSchema } from '@viesma/network-colyseus'
import {
  combatDamageMessage,
  inputFrameMessage,
  mapRoomJoinedMessage,
  mapRoomName,
  movementCheckpointMessage,
  PROTOCOL_VERSION,
  villageMapRoomName,
} from '@viesma/protocol'
import { placePlayerAtSpawn, ticksPerSecond } from '@viesma/simulation'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { clearInterval, setInterval } from 'node:timers'
import { URL } from 'node:url'
import { createDestinationRoom, createMapRoomClass } from '../dist/adapters/map-room.js'
import { createMemoryEncounterRewardPort } from '../dist/runtime/encounter-reward-worker.js'
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
  peer.onMessage(combatDamageMessage, () => {})
  return peer
}

export async function startBrowserFixtureServer({ combatScenario = false, observeReward, beforeReward } = {}) {
  const data = loadGrayboxGameData()
  const version = joinVersion(data)
  const tiledMaps = combatScenario
    ? data.tiledMaps.map((map) =>
        map.id !== 'm1'
          ? map
          : {
              ...map,
              // 保留相同地形。角色出生在 Slime 射程外及玩家 hitbox 內，走近才會受傷。
              spawns: map.spawns.map((spawn) => (spawn.id === 'spawn_from_village' ? { ...spawn, position: { x: 411, y: 848 } } : spawn)),
              monsterSpawns: map.monsterSpawns.map((spawn) =>
                spawn.id === 'spawn_slime_1' ? { ...spawn, patrolMinX: 464, patrolMaxX: 466 } : spawn
              ),
            }
      )
    : data.tiledMaps
  let latestTick = 0
  let tickCosts
  let wakeScheduled
  let clockOffset = 0
  let stagedNow
  const memory = createMemoryEncounterRewardPort()
  const world = createWorldCoordinator({ ...data, tiledMaps }, version.mapContentHash, {
    clock: { nowMilliseconds: () => stagedNow ?? performance.now() + clockOffset },
    nextId: randomUUID,
    createDestination: createDestinationRoom,
    ...((observeReward || beforeReward) && {
      rewardPort: {
        ...memory,
        async commitReward(intent) {
          if (beforeReward) await beforeReward()
          const receipt = memory.commitReward(intent)
          observeReward?.(intent, receipt)
          return receipt
        },
      },
    }),
    onBacklog() {},
    schedule(wake, milliseconds) {
      wakeScheduled = wake
      const timer = setInterval(() => {
        if (!tickCosts) return wake()
        const before = latestTick
        const start = performance.now()
        wake()
        if (latestTick === before + 1) tickCosts.push(performance.now() - start)
      }, milliseconds)
      return () => {
        wakeScheduled = undefined
        clearInterval(timer)
      }
    },
  })
  const transport = new WebSocketTransport({ maxPayload: 4096 })
  const server = new Server({ transport, gracefullyShutdown: false, greet: false })
  const ownerAcks = new WeakMap()
  let room
  let pendingApproach
  const observedWorld = {
    ...world,
    createRoom(mapId, roomId) {
      const runtime = world.createRoom(mapId, roomId)
      if (mapId === 'm1') room = runtime
      const advance = runtime.advance
      runtime.advance = (frame, now) => {
        if (runtime === room && pendingApproach) {
          const { connection, characterId, hp } = pendingApproach
          pendingApproach = undefined
          const body = runtime.player(characterId)
          if (body?.vitals.hp > 0) {
            const positioned = placePlayerAtSpawn(body, { x: 435, y: 848 }, 'right')
            runtime.respawn(connection, hp === undefined ? positioned : { ...positioned, vitals: { ...positioned.vitals, hp } })
          }
        }
        advance(frame, now)
        latestTick = frame.tick
      }
      const checkpoint = runtime.checkpoint
      runtime.checkpoint = (connection) => {
        const result = checkpoint(connection)
        if (result) ownerAcks.set(connection, result.ackInputSeq)
        return result
      }
      return runtime
    },
  }
  server.define(mapRoomName, createMapRoomClass(observedWorld, version))
  server.define(villageMapRoomName, createMapRoomClass(observedWorld, version, 15, 'village'))
  await server.listen(0, '127.0.0.1')
  const address = `127.0.0.1:${transport.server.address().port}`
  return {
    address,
    async reserve(options) {
      const seat = await matchMaker.joinOrCreate(mapRoomName, options)
      return { ...seat, publicAddress: address }
    },
    drop({ roomId, sessionId }) {
      const connection = matchMaker.getLocalRoomById(roomId)?.clients.getById(sessionId)
      if (!connection) return false
      connection.ref.terminate()
      return true
    },
    players({ roomId }) {
      return [...(matchMaker.getLocalRoomById(roomId)?.state.players.keys() ?? [])]
    },
    monsterHp({ roomId }, monsterId) {
      return matchMaker.getLocalRoomById(roomId)?.state.monsters.get(monsterId)?.hp
    },
    advanceWorldTicks(count) {
      const wake = wakeScheduled
      if (!wake) throw new Error('The fixture world is not running')
      const start = performance.now() + clockOffset
      const originalTick = latestTick
      // 讓固定 tick driver 逐步處理等待時間，瀏覽器保留實際連線及 patch 排程。
      try {
        for (let index = 1; index <= count; index++) {
          stagedNow = start + (index * 1000) / ticksPerSecond
          wake()
        }
      } finally {
        clockOffset += (count * 1000) / ticksPerSecond
        stagedNow = undefined
      }
      return latestTick - originalTick
    },
    ownerAck({ roomId, sessionId }) {
      const connection = matchMaker.getLocalRoomById(roomId)?.clients.getById(sessionId)
      return connection && ownerAcks.get(connection)
    },
    approachSlime({ roomId, sessionId }, hp) {
      const connection = matchMaker.getLocalRoomById(roomId)?.clients.getById(sessionId)
      const binding = connection && room?.binding(connection)
      if (!combatScenario || !binding) return false
      pendingApproach = { connection, characterId: binding.characterId, hp }
      return true
    },
    malformedAttack({ roomId, sessionId }) {
      const connection = matchMaker.getLocalRoomById(roomId)?.clients.getById(sessionId)
      const binding = connection && room?.binding(connection)
      if (!binding) throw new Error('Missing combat smoke player connection')
      let received = false
      const socket = connection.ref
      function observe(data) {
        if (!data.includes('damage')) return
        received = true
        socket.off('message', observe)
      }
      socket.on('message', observe)
      return {
        bytes: Buffer.from(
          getMessageBytes.raw(Protocol.ROOM_DATA, inputFrameMessage, {
            protocolVersion: PROTOCOL_VERSION,
            connectionEpoch: binding.connectionEpoch,
            mapEpoch: binding.mapEpoch,
            seq: (ownerAcks.get(connection) ?? 0) + 6,
            moveX: 0,
            jumpPressed: false,
            attackPressed: true,
            damage: 999,
          })
        ),
        received: () => received,
      }
    },
    measureTicks() {
      const start = performance.now()
      const firstTick = latestTick
      const firstCatchUp = world.tickDiagnostics().catchUpTicks
      const costs = []
      tickCosts = costs
      return () => {
        tickCosts = undefined
        return { costs, ticks: latestTick - firstTick, catchUpTicks: world.tickDiagnostics().catchUpTicks - firstCatchUp, start }
      }
    },
    close: () => server.gracefullyShutdown(false),
  }
}
