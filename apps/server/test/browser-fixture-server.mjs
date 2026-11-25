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
  parseInputFrame,
  parsePortalRequest,
  PROTOCOL_VERSION,
  villageMapRoomName,
} from '@viesma/protocol'
import { canUseGroundedInteraction, findOverlappingPortal, placePlayerAtSpawn, ticksPerSecond } from '@viesma/simulation'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { clearInterval, setInterval } from 'node:timers'
import { URL } from 'node:url'
import { createDestinationRoom, createMapRoomClass } from '../dist/adapters/map-room.js'
import { createMemoryEncounterRewardPort } from '../dist/runtime/encounter-reward-worker.js'
import { createWorldCoordinator } from '../dist/runtime/world-coordinator.js'
import { movementSmokeData } from './movement-smoke-fixture.mjs'
import { progressionTestData } from './progression-fixture.mjs'

function joinVersion(data) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    balanceVersion: data.balanceVersion,
    mapContentHash: createHash('sha256').update(serializeMapManifest(data)).digest('hex'),
  }
}

function movementState({ position, physics, movement, locomotion, action, lastHurtTick, vitals, spawnProtected }) {
  return {
    x: position.x,
    y: position.y,
    vy: physics.velocity.y,
    vx: physics.velocity.x,
    grounded: physics.grounded,
    inVoid: physics.inVoid,
    locomotion,
    action: action.kind,
    hurtRemaining: action.kind === 'hurt' ? action.ticksRemaining : undefined,
    lastHurtTick,
    hp: vitals?.hp,
    spawnProtected,
    appliedSeq: movement.lastProcessedInputSeq,
    moveX: movement.moveX,
    jumpBuffer: movement.jumpBufferTicksRemaining,
    coyote: movement.coyoteTicksRemaining,
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

export async function startBrowserFixtureServer({
  combatScenario = false,
  movementScenario = false,
  progressionScenario = false,
  traceMovement = false,
  observeReward,
  beforeReward,
} = {}) {
  const original = loadGrayboxGameData()
  const data = progressionScenario ? progressionTestData() : original
  const version = joinVersion(original)
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
    : movementScenario
      ? movementSmokeData(data).tiledMaps
      : data.tiledMaps
  let latestTick = 0
  let tickCosts
  let wakeScheduled
  let clockOffset = 0
  let stagedNow
  let movementTrace
  const memory = createMemoryEncounterRewardPort()
  const clock = { nowMilliseconds: () => stagedNow ?? performance.now() + clockOffset }
  const world = createWorldCoordinator({ ...data, tiledMaps }, version.mapContentHash, {
    clock,
    nextId: randomUUID,
    createDestination: createDestinationRoom,
    ...(traceMovement && { watchMovement: (id) => (movementTrace?.characterId === id ? movementTrace.capture : undefined) }),
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
  const tracedRooms = new Map()
  let room
  let pendingApproach
  function movementAt(runtime, connection) {
    const binding = connection && runtime?.binding(connection)
    const body = binding && runtime.player(binding.characterId)
    if (!body) return null
    const portal = findOverlappingPortal(runtime.map, body.position)
    return {
      ...binding,
      roomId: runtime.roomId,
      mapId: runtime.map.id,
      serverTick: latestTick,
      ...movementState(body),
      ackInputSeq: ownerAcks.get(connection) ?? null,
      eligiblePortal: canUseGroundedInteraction(body) ? (portal?.id ?? null) : null,
    }
  }
  const observedWorld = {
    ...world,
    requestPortal(runtime, connection, payload) {
      const trace = movementTrace
      if (trace?.inTransfer && runtime.binding(connection)?.characterId === trace.characterId) {
        const request = parsePortalRequest(payload)
        const accepted = world.requestPortal(runtime, connection, payload)
        trace.append({ kind: 'portal-received', request, accepted, ...movementAt(runtime, connection) })
        return accepted
      }
      return world.requestPortal(runtime, connection, payload)
    },
    receive(runtime, connection, payload) {
      const trace = movementTrace
      const binding = trace && runtime.binding(connection)
      if (!binding || binding.characterId !== trace.characterId) return world.receive(runtime, connection, payload)
      const frame = parseInputFrame(payload)
      if (trace.inTransfer && !frame?.moveX) return world.receive(runtime, connection, payload)
      const receipt = trace.append({
        kind: 'receipt',
        serverTick: latestTick,
        inputSeq: frame?.seq ?? null,
        moveX: frame?.moveX ?? null,
        jumpPressed: frame?.jumpPressed ?? null,
        mapEpoch: frame?.mapEpoch ?? null,
        epochMatches: frame?.connectionEpoch === binding.connectionEpoch && frame?.mapEpoch === binding.mapEpoch,
        monotonicMs: clock.nowMilliseconds(),
      })
      const accepted = world.receive(runtime, connection, payload)
      if (receipt) receipt.accepted = accepted
      return accepted
    },
    createRoom(mapId, roomId) {
      const runtime = world.createRoom(mapId, roomId)
      if (traceMovement) {
        tracedRooms.set(roomId, runtime)
        const freeze = runtime.freeze
        const prepareArrival = runtime.prepareArrival
        const rebind = runtime.rebind
        runtime.freeze = (connection) => {
          if (movementTrace?.inTransfer && runtime.binding(connection)?.characterId === movementTrace.characterId)
            movementTrace.append({ kind: 'portal-eligible', ...movementAt(runtime, connection) })
          return freeze(connection)
        }
        runtime.prepareArrival = (connection, binding, body, now) => {
          const commit = prepareArrival(connection, binding, body, now)
          if (!commit || !movementTrace?.inTransfer || binding.characterId !== movementTrace.characterId) return commit
          return () => {
            commit()
            movementTrace?.append({ kind: 'committed', ...movementAt(runtime, connection), serverTick: latestTick + 1 })
          }
        }
        runtime.rebind = (characterId, connection, now) => {
          const binding = rebind(characterId, connection, now)
          if (binding && movementTrace?.inTransfer && characterId === movementTrace.characterId)
            movementTrace.append({ kind: 'rebound', ...movementAt(runtime, connection) })
          return binding
        }
      }
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
        if (result && movementTrace?.inTransfer && result.characterId === movementTrace.characterId)
          movementTrace.append({ kind: 'owner-checkpoint', ...movementAt(runtime, connection), serverTick: result.serverTick })
        return result
      }
      return runtime
    },
    disposeRoom(runtime) {
      tracedRooms.delete(runtime.roomId)
      world.disposeRoom(runtime)
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
    movementAt({ roomId, sessionId }) {
      return movementAt(tracedRooms.get(roomId), matchMaker.getLocalRoomById(roomId)?.clients.getById(sessionId))
    },
    progressionAt({ roomId, sessionId }) {
      const connection = matchMaker.getLocalRoomById(roomId)?.clients.getById(sessionId)
      if (room?.roomId === roomId && connection) return world.progression(room, connection)
    },
    startMovementTrace({ roomId, sessionId }, startedAt) {
      const connection = matchMaker.getLocalRoomById(roomId)?.clients.getById(sessionId)
      const binding = connection && room?.binding(connection)
      if (!traceMovement || !binding || movementTrace) throw new Error('Cannot arm the fixture movement trace')
      const events = []
      const transfer = []
      let dropped = 0
      let droppedTransfer = 0
      const append = (event) => {
        const inTransfer = movementTrace?.inTransfer
        const target = inTransfer ? transfer : events
        if (target.length >= 1024) {
          if (inTransfer) droppedTransfer++
          else dropped++
          return undefined
        }
        const row = { tMs: Math.round(performance.timeOrigin + performance.now() - startedAt), ...event }
        target.push(row)
        return row
      }
      movementTrace = {
        characterId: binding.characterId,
        append,
        inTransfer: false,
        capture(event) {
          if (movementTrace.inTransfer) {
            if (event.kind === 'input-retired' || (event.kind === 'input-decision' && (event.reason !== 'queued' || event.queueDepth > 1)))
              append(event)
            return
          }
          if (event.kind === 'controller') {
            const jumpLaunched = event.before.physics.velocity.y >= 0 && event.after.physics.velocity.y < 0
            if (event.jumpPressed || jumpLaunched)
              append({ ...event, before: movementState(event.before), after: movementState(event.after), jumpLaunched })
          } else if (event.kind === 'tick') {
            const { before, after, ...tick } = event
            append({ ...tick, ...(event.jumpPressed && { before: movementState(before) }), after: movementState(after) })
          } else if (event.kind === 'damage') {
            const { tick, monsterId, effectiveDamage, attackStartedTick } = event.event
            append({ kind: 'damage', serverTick: tick, monsterId, effectiveDamage, attackStartedTick })
          } else append(event)
        },
      }
      return {
        beginTransfer() {
          movementTrace.inTransfer = true
        },
        stop() {
          movementTrace = undefined
          return { characterId: binding.characterId, mapEpoch: binding.mapEpoch, events, dropped, transfer, droppedTransfer }
        },
      }
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
