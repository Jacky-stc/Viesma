import { Buffer } from 'node:buffer'
import { fork } from 'node:child_process'
import console from 'node:console'
import { createHash, createSecretKey } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, cpus, release, totalmem } from 'node:os'
import { createHistogram, monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks'
import process from 'node:process'
import { clearInterval, setInterval } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    stage: { type: 'string', default: 'A' },
    seconds: { type: 'string', default: '600' },
    warmup: { type: 'string', default: '15' },
    seed: { type: 'string', default: '20261126' },
    output: { type: 'string' },
  },
})
const { stage, output } = values
const seconds = Number(values.seconds)
const warmup = Number(values.warmup)
if (
  (stage !== 'A' && stage !== 'B' && stage !== 'C') ||
  !Number.isSafeInteger(seconds) ||
  seconds < 1 ||
  !values.warmup.trim() ||
  !Number.isSafeInteger(warmup) ||
  warmup < 0 ||
  (output !== undefined && (!output.trim() || output.includes('\0')))
) {
  throw new Error(
    'Usage: node apps/server/test/run-early-capacity.mjs --stage A|B|C [--seconds 600] [--warmup 15] [--seed seed] [--output path]'
  )
}
const roomCount = { A: 1, B: 3, C: 7 }[stage]

const { matchMaker, Server } = await import('@colyseus/core')
const { WebSocketTransport } = await import('@colyseus/ws-transport')
const { loadGrayboxGameData, serializeMapManifest } = await import('@viesma/game-data')
const { mapRoomName, PROTOCOL_VERSION, villageMapRoomName } = await import('@viesma/protocol')
const { createAudit } = await import('./capacity-audit.mjs')
const {
  count,
  counters,
  createRoomMetrics,
  distribution,
  findAuthorizedInFlight,
  installObserver,
  matchesOwner,
  observePrivateWrite,
  privateMessages,
  record,
} = await import('./capacity-observe.mjs')

if (output) writeFileSync(output, '')
function log(kind, data) {
  const line = JSON.stringify({ kind, ...data })
  if (output) appendFileSync(output, line + '\n')
  if (kind !== 'sample' || !output) console.log(line)
}

const errors = counters()
const runtimeErrors = []
function incident(message) {
  count(errors, message)
}

const worldMetrics = {
  rooms: new Map(),
  tick: createHistogram(),
  drift: createHistogram(),
  wakes: counters(),
  gc: createHistogram(),
  maxSteps: 0,
  backlogPeak: 0,
  eventLoop: monitorEventLoopDelay({ resolution: 10 }),
  network: counters(),
  measuring: false,
  incident,
}
const stopObserver = installObserver(worldMetrics)
const { createWorldCoordinator } = await import('../dist/runtime/world-coordinator.js')
const { createMapRoomClass, createDestinationRoom } = await import('../dist/adapters/map-room.js')
const { createMemoryCharacterRepository } = await import('../dist/runtime/memory-character-repository.js')
const { getMonsterSpawnDefinitions } = await import('../dist/runtime/monster-spawns.js')
const { createServerLootRng } = await import('../dist/runtime/loot-rng.js')
stopObserver.deregister()

const data = loadGrayboxGameData()
const version = {
  protocolVersion: PROTOCOL_VERSION,
  balanceVersion: data.balanceVersion,
  mapContentHash: createHash('sha256').update(serializeMapManifest(data)).digest('hex'),
}
const spawnDefinitions = getMonsterSpawnDefinitions(
  data,
  data.tiledMaps.find(({ id }) => id === 'm1')
)
const audit = createAudit(data, spawnDefinitions, incident)
worldMetrics.audit = audit
const runtimes = new Map()
const historicalRooms = []
const routes = new Map()
const retiredRoutes = new Map()
const admission = counters()
const lifecycle = counters()
const transportErrors = counters()
let nextId = 0
let latestClient
let ready
let shuttingDown = false
let interrupted
let disconnected = false
const gc = new PerformanceObserver((list) => {
  if (worldMetrics.measuring) for (const event of list.getEntries()) record(worldMetrics.gc, event.duration)
})
process.on('SIGINT', () => (interrupted = 'SIGINT'))
process.on('SIGTERM', () => (interrupted = 'SIGTERM'))
process.on('unhandledRejection', (error) => {
  runtimeErrors.push(String(error))
  incident('Unhandled rejection in server')
})
process.on('uncaughtException', (error) => {
  runtimeErrors.push(String(error))
  incident('Uncaught exception in server')
})

const world = createWorldCoordinator(data, version.mapContentHash, {
  clock: { nowMilliseconds: () => performance.now() },
  nextId: () => 'capacity-' + values.seed + '-' + String(++nextId).padStart(9, '0'),
  createDestination: createDestinationRoom,
  rewardRandom: createServerLootRng(createSecretKey(createHash('sha256').update(values.seed).digest())),
  wrapRewardPort: audit.wrapRewardPort,
  characterRepositoryFactory: (items, ground) => audit.wrapRepository(createMemoryCharacterRepository(items, ground), ground),
  watchMovement: (characterId) => routes.get(characterId)?.observeInput,
  schedule(wake, interval) {
    count(lifecycle, 'schedulerStarts')
    const timer = setInterval(wake, interval)
    return () => {
      count(lifecycle, 'schedulerStops')
      clearInterval(timer)
      if (ready && !shuttingDown) incident('Unexpected scheduler stop')
    }
  },
  onBacklog: () => count(lifecycle, 'backlogEpisodes'),
  onBacklogRecovered: () => count(lifecycle, 'backlogRecoveries'),
})

function verifyBinding(runtime, peer, payload) {
  const binding = runtime.binding(peer.connection)
  if (!matchesOwner(binding, payload)) {
    incident('Private message addressed to stale or foreign server socket')
  }
}

function inputObserver(metrics) {
  let depth = 0
  return (event) => {
    let nextDepth = depth
    if (event.kind === 'input-decision') {
      count(metrics.input, event.reason)
      nextDepth = event.queueDepth
      metrics.inputDepth = Math.max(metrics.inputDepth, nextDepth)
    }
    if (event.kind === 'input-retired') {
      count(metrics.input, 'retired:' + event.reason)
      nextDepth = Math.max(0, depth - 1)
    }
    if (event.kind === 'tick' && event.inputSeq !== null) nextDepth = Math.max(0, depth - 1)
    metrics.queuedInputs += nextDepth - depth
    metrics.queuedInputsPeak = Math.max(metrics.queuedInputsPeak, metrics.queuedInputs)
    depth = nextDepth
  }
}

function observePeer(runtime, peer, kind) {
  const socket = peer.connection
  const originalSend = socket.send
  socket.send = function (type, payload, ...args) {
    if (privateMessages.has(type)) {
      const route = routes.get(payload.characterId)
      if (route?.socket !== socket || !matchesOwner(runtime.binding(socket), payload)) {
        incident('Private payload sent after revocation or to a foreign socket: ' + type)
      } else {
        observePrivateWrite(route, type, payload, worldMetrics.latestTick ?? 0)
      }
    }
    return originalSend.call(this, type, payload, ...args)
  }
  return {
    ...peer,
    joined(binding) {
      const prior = routes.get(binding.characterId)
      if (prior) {
        const revokedAt = (worldMetrics.latestTick ?? 0) + 1
        retiredRoutes.set(JSON.stringify([prior.runtime.roomId, prior.socket.sessionId]), { revokedAt, messages: prior.messages })
        if (
          world.checkpoint(prior.runtime, prior.socket) ||
          world.ownerGroundLoot(prior.runtime, prior.socket) ||
          world.progression(prior.runtime, prior.socket) ||
          world.inventory(prior.runtime, prior.socket) ||
          world.receive(prior.runtime, prior.socket, {
            protocolVersion: PROTOCOL_VERSION,
            connectionEpoch: prior.epoch,
            mapEpoch: prior.mapEpoch,
            seq: 0,
            moveX: 1,
            jumpPressed: false,
            attackPressed: true,
          })
        ) {
          incident('Revoked binding can still mutate or obtain private data')
        }
        count(lifecycle, 'revokedBindingsChecked')
      }
      const metrics = worldMetrics.rooms.get(runtime.mapInstanceId)
      routes.set(binding.characterId, {
        runtime,
        observeInput: inputObserver(metrics),
        socket,
        messages: new Map(),
        epoch: binding.connectionEpoch,
        mapEpoch: binding.mapEpoch,
      })
      count(admission, kind + ':authoritative')
      peer.joined(binding)
    },
    progression(payload) {
      verifyBinding(runtime, peer, payload)
      if (payload.reward) count(lifecycle, 'rewardNotifications')
      peer.progression(payload)
    },
    inventory(payload) {
      verifyBinding(runtime, peer, payload)
      peer.inventory(payload)
    },
    lootResult(payload) {
      verifyBinding(runtime, peer, payload)
      audit.finishCommand(payload)
      peer.lootResult(payload)
    },
    failed(failure) {
      count(lifecycle, 'transferFailure:' + failure.code)
      peer.failed(failure)
    },
  }
}

const observedWorld = {
  ...world,
  createRoom(...args) {
    const runtime = world.createRoom(...args)
    const metrics = createRoomMetrics(runtime, incident)
    worldMetrics.rooms.set(runtime.mapInstanceId, metrics)
    runtimes.set(runtime.roomId, runtime)
    historicalRooms.push(metrics)
    const advance = runtime.advance
    runtime.advance = (...args) => {
      const start = performance.now()
      advance(...args)
      if (worldMetrics.measuring) record(metrics.tickCost, performance.now() - start)
    }
    return runtime
  },
  disposeRoom(runtime) {
    world.disposeRoom(runtime)
    const metrics = worldMetrics.rooms.get(runtime.mapInstanceId)
    metrics.disposed = true
    runtimes.delete(runtime.roomId)
  },
  join(runtime, peer) {
    const accepted = world.join(runtime, observePeer(runtime, peer, 'fresh'))
    if (!accepted) count(admission, 'fresh:MAP_SEAT_UNAVAILABLE')
    return accepted
  },
  reconnect(runtime, peer, token) {
    const accepted = world.reconnect(runtime, observePeer(runtime, peer, 'reconnect'), token)
    if (!accepted) count(admission, 'reconnect:MAP_ADMISSION_INVALID')
    return accepted
  },
  acceptTransfer(runtime, peer, ...credentials) {
    const accepted = world.acceptTransfer(runtime, observePeer(runtime, peer, 'transfer'), ...credentials)
    if (!accepted) count(admission, 'transfer:MAP_ADMISSION_INVALID')
    return accepted
  },
  receive(runtime, peer, payload) {
    const accepted = world.receive(runtime, peer, payload)
    if (!accepted && !runtime.binding(peer)) count(lifecycle, 'inputWithoutBinding')
    return accepted
  },
  requestGroundLoot(runtime, peer, payload, kind) {
    const binding = runtime.binding(peer)
    if (binding) audit.beginCommand(binding, payload, kind)
    world.requestGroundLoot(runtime, peer, payload, kind)
  },
  ownerGroundLoot(...args) {
    const message = world.ownerGroundLoot(...args)
    if (message) {
      verifyBinding(args[0], { connection: args[1] }, message.update)
      const { update } = message
      for (const { lootId } of update.kind === 'snapshot' ? update.loot : update.added) {
        if (audit.grants.get(lootId)?.ownerCharacterId !== update.characterId) incident('Private ground grant reached a foreign owner')
      }
    }
    return message
  },
}

const transport = new WebSocketTransport({ maxPayload: 4096 })
transport.wss.on('connection', (socket, req) => {
  const roomId = new URL(req.url, 'http://127.0.0.1').pathname.split('/').at(-1)
  const runtime = runtimes.get(roomId)
  const metrics = runtime && worldMetrics.rooms.get(runtime.mapInstanceId)
  const rawSend = socket.send
  socket.send = function (payload, ...args) {
    const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength
    count(worldMetrics.network, 'outMessages')
    count(worldMetrics.network, 'outBytes', bytes)
    if (metrics) {
      count(metrics.network, 'outMessages')
      count(metrics.network, 'outBytes', bytes)
    }
    const result = rawSend.call(this, payload, ...args)
    if (metrics) metrics.bufferedPeak = Math.max(metrics.bufferedPeak, socket.bufferedAmount)
    return result
  }
  socket.on('message', (payload) => {
    count(worldMetrics.network, 'inMessages')
    count(worldMetrics.network, 'inBytes', payload.byteLength)
    if (metrics) {
      count(metrics.network, 'inMessages')
      count(metrics.network, 'inBytes', payload.byteLength)
    }
  })
  socket.on('error', (error) => count(transportErrors, error.code ?? error.name))
})

const server = new Server({ transport, gracefullyShutdown: false, greet: false })
function define(name, mapId) {
  const ProductionRoom = createMapRoomClass(observedWorld, version, 15, mapId)
  server.define(
    name,
    class extends ProductionRoom {
      onBeforePatch() {
        const start = performance.now()
        super.onBeforePatch()
        const runtime = runtimes.get(this.roomId)
        if (runtime && worldMetrics.measuring) record(worldMetrics.rooms.get(runtime.mapInstanceId).patchCost, performance.now() - start)
      }
    }
  )
}
define(mapRoomName, 'm1')
define(villageMapRoomName, 'village')

const child = fork(new URL('./capacity-client.mjs', import.meta.url), [], {
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  windowsHide: true,
})
child.on('error', (error) => {
  runtimeErrors.push(String(error))
  incident('Load process spawn or IPC error')
})
child.on('exit', (code, signal) => {
  disconnected = true
  if (!shuttingDown || code !== 0 || signal) {
    runtimeErrors.push('Load process exited: ' + JSON.stringify({ code, signal }))
    if (!shuttingDown) incident('Unexpected load process exit')
  }
})
child.on('message', (message) => {
  switch (message.kind) {
    case 'ready':
      ready = message.rooms
      break
    case 'drop': {
      const socket = matchMaker.getLocalRoomById(message.roomId)?.clients.getById(message.sessionId)?.ref
      if (socket) {
        socket.terminate()
        count(lifecycle, 'controlledDrops')
      }
      break
    }
    case 'clientSample':
      latestClient = message.data
      break
    case 'fullRejection':
      log('fullRejection', message.error)
      count(admission, '21st:' + message.error.code)
      break
    case 'retiredPrivate': {
      const route = retiredRoutes.get(JSON.stringify([message.roomId, message.sessionId]))
      const write = findAuthorizedInFlight(route, message)
      if (!write) {
        incident('Retired socket delivered an unverified private payload: ' + message.type)
      } else {
        count(lifecycle, 'inFlightPrivateDiscarded:' + message.type)
        log('retiredPrivate', { type: message.type, stamp: message.stamp, socketWriteTick: write.worldTick, revokedAt: route.revokedAt })
      }
      break
    }
    case 'error':
      runtimeErrors.push(JSON.stringify(message.error))
      incident('Load generator observed an error')
      break
  }
})

function checkMembers() {
  const unique = new Set()
  const bodies = new Set()
  let active = 0
  let offline = 0
  let incoming = 0
  let retained = 0
  for (const runtime of runtimes.values()) {
    const metrics = worldMetrics.rooms.get(runtime.mapInstanceId)
    for (const characterId of [...metrics.connections.values(), ...metrics.disconnected]) {
      if (unique.has(characterId)) incident('Duplicate character seat across authoritative rooms')
      unique.add(characterId)
    }
    for (const { characterId } of runtime.snapshot().players) {
      if (bodies.has(characterId)) incident('Duplicate authoritative body across rooms')
      bodies.add(characterId)
    }
    active += metrics.connections.size
    offline += metrics.disconnected.size
    incoming += metrics.incoming.size
    if (runtime.hasRetainedSeats()) retained++
  }
  return { active, offline, incoming, unique: unique.size, bodies: bodies.size, retained, connections: transport.wss.clients.size }
}

function snapshot() {
  const { user, system } = process.cpuUsage()
  return {
    timeMs: performance.now(),
    cpuMs: (user + system) / 1000,
    memory: process.memoryUsage(),
    membership: checkMembers(),
    lifecycle,
    admission,
    transportErrors,
    network: worldMetrics.network,
    audit: audit.sample(),
    backlog: world.tickDiagnostics(),
    errors,
    runtimeErrors,
    client: latestClient,
    rooms: historicalRooms.map((room) => ({
      roomId: room.roomId,
      map: room.mapId,
      disposed: !!room.disposed,
      active: room.connections.size,
      disconnected: room.disconnected.size,
      incoming: room.incoming.size,
      activePeak: room.activePeak,
      reservedPeak: room.reservedPeak,
      seatsPeak: room.seatsPeak,
      playerTick: distribution(room.tickCost),
      patch: distribution(room.patchCost),
      monsters: room.monsters,
      liveMonsters: room.liveMonsters,
      combat: room.events,
      input: room.input,
      inputDepth: room.inputDepth,
      queuedInputsPeak: room.queuedInputsPeak,
      network: room.network,
      bufferedPeak: room.bufferedPeak,
    })),
  }
}

function message(kind, extra = {}) {
  if (child.connected) child.send({ kind, ...extra })
}

async function sampleClient() {
  const previous = latestClient
  message('sample')
  for (let index = 0; index < 20 && latestClient === previous && child.connected; index++) await delay(10)
}

async function waitFor(read, timeout, description) {
  const deadline = performance.now() + timeout
  while (!read() && !interrupted && !Object.keys(errors).length) {
    if (performance.now() >= deadline) throw new Error(description)
    await delay(20)
  }
}

let baseline
let end
let verdict = 'INCONCLUSIVE'
let reason
try {
  await server.listen(0, '127.0.0.1')
  const address = 'http://127.0.0.1:' + transport.server.address().port
  log('environment', {
    stage,
    clients: roomCount * 20,
    combatRooms: roomCount,
    seconds,
    warmup,
    seed: values.seed,
    address,
    node: process.version,
    os: process.platform + ' ' + release(),
    cpu: cpus()[0].model,
    logicalCpus: availableParallelism(),
    ram: totalmem(),
    version,
    monsters: spawnDefinitions.map(({ spawnId, maxHp, baseExp }) => ({ spawnId, maxHp, baseExp })),
  })
  message('boot', { address, rooms: roomCount, version })
  await waitFor(() => ready, 30_000, 'Initial admissions did not finish')
  if (ready) {
    const members = checkMembers()
    if (
      members.active !== roomCount * 20 ||
      ready.some((id) => worldMetrics.rooms.get(runtimes.get(id)?.mapInstanceId)?.connections.size !== 20)
    ) {
      incident('Initial authoritative seat distribution differs from target')
    }
    log('admitted', members)
  }
  if (warmup) {
    const warmed = performance.now() + warmup * 1000
    await waitFor(() => performance.now() >= warmed, warmup * 1000 + 5000, 'Warmup deadline missed')
  }
  await sampleClient()
  baseline = JSON.parse(JSON.stringify(snapshot()))
  log('baseline', baseline)
  const reconnectAt = Array.from({ length: roomCount }, (_, room) => 7 + 2 * room)
  worldMetrics.measuring = true
  worldMetrics.eventLoop.enable()
  gc.observe({ entryTypes: ['gc'] })
  let lastSample = -5
  while (performance.now() - baseline.timeMs < seconds * 1000 && !Object.keys(errors).length && !interrupted) {
    const elapsed = (performance.now() - baseline.timeMs) / 1000
    for (let room = 0; room < roomCount; room++) {
      if (elapsed < reconnectAt[room]) continue
      reconnectAt[room] += 30
      message('reconnect', { index: room * 20 + 16 + (Math.floor(elapsed / 30) % 4) })
    }
    if (elapsed - lastSample >= 5) {
      await sampleClient()
      const current = snapshot()
      log('sample', { seconds: elapsed, ...current })
      lastSample = elapsed
      if (Object.keys(current.client?.errors ?? {}).length) incident('Load workload reported unresolved commands or handoffs')
      if (current.membership.unique !== roomCount * 20 && elapsed > 1) {
        incident('Authoritative character seat lost during load')
      }
      if (current.memory.rss - baseline.memory.rss >= 512 * 1024 * 1024) {
        reason = 'Server RSS grew by at least 512 MiB'
        break
      }
    }
    await delay(100)
  }
  worldMetrics.measuring = false
  worldMetrics.eventLoop.disable()
  gc.disconnect()
  await sampleClient()
  end = snapshot()
  const tick = distribution(worldMetrics.tick)
  const elapsed = (end.timeMs - baseline.timeMs) / 1000
  const clientEvents = end.client?.events ?? {}
  if (Object.keys(errors).length || Object.keys(end.client?.errors ?? {}).length) verdict = 'CORRECTNESS_FAILURE'
  else if (reason || tick.p95 >= 20 || tick.p99 >= 1000 / 30) verdict = 'PERFORMANCE_LIMITED'
  else if (seconds >= 600 && elapsed >= 600 && !interrupted) {
    const missingWorkload = ['portalTransfers', 'reconnectSuccess', 'pickup:CONFIRMED', 'attackSent', 'jumpSent'].filter(
      (key) => !(clientEvents[key] > (baseline.client?.events[key] ?? 0))
    )
    if (!(end.audit.stats.rewardCommits > (baseline.audit.stats.rewardCommits ?? 0))) missingWorkload.push('rewardCommits')
    const combatEvents = ['monsterDamaged', 'playerDamaged', 'monsterDeathsCompleted', 'monsterRespawns', 'upwardLaunches']
    for (const key of combatEvents) {
      if (end.rooms.some((room) => room.map === 'm1' && !room.combat[key])) missingWorkload.push(key)
    }
    if (missingWorkload.length) reason = 'Workload did not observe: ' + missingWorkload.join(', ')
    else verdict = 'VERIFIED'
  }
  log('measured', {
    verdict,
    reason,
    interrupted,
    elapsed,
    tick,
    drift: distribution(worldMetrics.drift),
    eventLoop: distribution(worldMetrics.eventLoop),
    gc: distribution(worldMetrics.gc),
    wakes: worldMetrics.wakes,
    maxSteps: worldMetrics.maxSteps,
    backlogPeak: worldMetrics.backlogPeak,
    ...end,
  })
} catch (error) {
  reason = String(error)
  verdict = Object.keys(errors).length ? 'CORRECTNESS_FAILURE' : 'INCONCLUSIVE'
  log('runError', { reason, verdict })
} finally {
  shuttingDown = true
  message('stop')
  const childDeadline = performance.now() + 3000
  while (!disconnected && performance.now() < childDeadline) await delay(30)
  if (!disconnected) child.kill()
  const drainDeadline = performance.now() + 32_000
  while (performance.now() < drainDeadline) {
    const { active, offline, incoming } = checkMembers()
    if (!active && !offline && !incoming && !audit.sample().pending) break
    await delay(100)
  }
  const drained = snapshot()
  if (
    drained.audit.pending ||
    drained.audit.commandOutstanding ||
    drained.membership.active ||
    drained.membership.offline ||
    drained.membership.incoming
  ) {
    incident('Unresolved work or authoritative seat after drain')
  }
  await server.gracefullyShutdown(false)
  const afterShutdown = snapshot()
  if (
    runtimes.size ||
    afterShutdown.membership.connections ||
    afterShutdown.audit.retainedDeathReceipts ||
    afterShutdown.audit.receiptCount ||
    lifecycle.schedulerStarts !== lifecycle.schedulerStops
  ) {
    incident('Server failed to release rooms, receipts, sockets or scheduler')
  }
  if (Object.keys(errors).length) verdict = 'CORRECTNESS_FAILURE'
  log('cleanup', { verdict, drained, afterShutdown })
  if (verdict !== 'VERIFIED') process.exitCode = 1
}
