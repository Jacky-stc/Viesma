import { isNonNegativeSafeInteger, toSimulationTick, type CharacterId, type MapInstanceId, type SimulationTick } from '@viesma/domain'
import { monsterMaxHpAtLevel, type GameData, type NormalizedMap } from '@viesma/game-data'
import {
  parsePortalRequest,
  type MapRoomSession,
  type OnlineMapId,
  type PortalRequest,
  type TransferFailure,
  type TransferOffer,
} from '@viesma/protocol'
import {
  canUseGroundedInteraction,
  createFixedTickDriver,
  findOverlappingPortal,
  maxCatchUpTicks,
  placePlayerAtSpawn,
  respawnPlayer,
  ticksPerSecond,
  type MonotonicClock,
} from '@viesma/simulation'
import { createMapRuntime, type MapRuntime } from './map-runtime.ts'

interface WorldDependencies {
  readonly clock: MonotonicClock
  readonly schedule: (wake: () => void, intervalMilliseconds: number) => () => void
  readonly nextId: () => string
  readonly onBacklog: (backlogTicks: number) => void
  readonly onBacklogRecovered?: (recoveryMilliseconds: number, catchUpTicks: number) => void
  readonly createDestination?: (mapId: OnlineMapId) => Promise<unknown>
}

export interface RoomPeer {
  readonly connection: object
  readonly joined: (session: MapRoomSession) => void
  readonly offer: (offer: TransferOffer) => void
  readonly failed: (failure: TransferFailure) => void
  readonly close: () => void
}

interface CharacterRoute {
  readonly characterId: CharacterId
  reconnectToken: string
  unconfirmedToken: string | undefined
  room: MapRuntime
  peer: RoomPeer | undefined
  reconnectUntil: number | undefined
  lastPortalRequestId: number
  portal: PortalRequest | undefined
  transfer: Transfer | undefined
  nextRespawnMilliseconds: number
}

type Spawn = NormalizedMap['spawns'][number]
type Creation = { status: 'pending' | 'failed' | 'created' }
interface Transfer {
  readonly requestId: number | null
  readonly mapId: OnlineMapId
  readonly spawn: Spawn
  readonly mapEpoch: number
  readonly expiresAt: number
  creation?: Creation
  destination?: MapRuntime
  ticket?: string
  candidate?: RoomPeer
  canceled?: boolean
}

const transferMilliseconds = 10_000
const reconnectMilliseconds = 30_000
const respawnRetryMilliseconds = 1_000

function closePeer(peer: RoomPeer | undefined): void {
  try {
    peer?.close()
  } catch {
    // 路由已撤銷。舊 transport 的關閉失敗不影響世界步進。
  }
}

function reportFailure(peer: RoomPeer | undefined, failure: TransferFailure): void {
  try {
    peer?.failed(failure)
  } catch {
    // 失敗通知送不出去時，客戶端仍有逾時與斷線處理。
  }
}

export function createWorldCoordinator(data: GameData, mapContentHash: string, dependencies: WorldDependencies) {
  const m1 = data.tiledMaps.find(({ id }) => id === 'm1')
  const village = data.tiledMaps.find(({ id }) => id === 'village')
  const m1Spawn = m1?.spawns.find(({ id }) => id === 'spawn_from_village')
  const villageSpawn = village?.spawns.find(({ id }) => id === data.world.respawn.spawnId)
  if (!m1 || !m1Spawn || !village || !villageSpawn)
    throw new RangeError('M3.4 requires the M1 and Village maps and their development spawns')
  const maps = { m1, village }
  const spawns = { m1: m1Spawn, village: villageSpawn }
  const monsterSpawn = m1.monsterSpawns.find(({ id }) => id === 'spawn_slime_1')
  const archetype = data.monsters.find(({ id }) => id === monsterSpawn?.monsterArchetypeId)
  if (monsterSpawn?.movement !== 'ground' || !archetype) throw new RangeError('M1 requires a ground monster fixture at spawn_slime_1')
  const fixture = {
    spawn: monsterSpawn,
    patrolSpeed: archetype.patrolSpeed,
    maxHp: Number(monsterMaxHpAtLevel(archetype, monsterSpawn.level, data.monsterScaling)),
  }

  const { clock, schedule, nextId, onBacklog, createDestination } = dependencies
  const bootId = nextId()
  const rooms = new Map<MapInstanceId, MapRuntime>()
  const routes = new Map<CharacterId, CharacterRoute>()
  const connections = new Map<object, CharacterRoute>()
  const reconnectTokens = new Map<string, CharacterRoute>()
  const tickets = new Map<string, CharacterRoute>()
  const candidates = new Map<object, CharacterRoute>()
  const creations = new Map<OnlineMapId, Creation>()
  let stop: (() => void) | undefined
  let tick = toSimulationTick(0)
  let backlogTicks = 0
  let backlogStartedAt: number | undefined
  let catchUpTicks = 0
  let lastBacklogRecoveryMilliseconds: number | undefined
  let instanceSequence = 0
  let catchingUp = false

  const canAdmit = () => backlogTicks === 0 && !catchingUp
  const registered = (room: MapRuntime) => rooms.get(room.mapInstanceId) === room

  function clearTransfer(route: CharacterRoute, reservationConsumed = false) {
    const transfer = route.transfer
    if (!transfer) return
    route.transfer = undefined
    if (transfer.ticket) tickets.delete(transfer.ticket)
    if (transfer.candidate) candidates.delete(transfer.candidate.connection)
    if (!reservationConsumed) transfer.destination?.cancelReservation(route.characterId)
    return transfer
  }

  function failTransfer(route: CharacterRoute, code: TransferFailure['code'], now: number): void {
    const transfer = clearTransfer(route)
    if (!transfer) return
    if (route.peer) route.room.resume(route.peer.connection)
    route.nextRespawnMilliseconds = now + respawnRetryMilliseconds
    reportFailure(route.peer, { requestId: transfer.requestId, code })
    closePeer(transfer.candidate)
  }

  function createMissingRoom(mapId: OnlineMapId): Creation {
    const existing = creations.get(mapId)
    if (existing) return existing
    const creation: Creation = { status: 'pending' }
    creations.set(mapId, creation)
    void Promise.resolve()
      .then(() => createDestination?.(mapId))
      .then(
        () => {
          creation.status = createDestination ? 'created' : 'failed'
        },
        () => {
          creation.status = 'failed'
        }
      )
      .finally(() => creations.delete(mapId))
    return creation
  }

  function prepareTransfer(route: CharacterRoute, transfer: Transfer, now: number) {
    if (transfer.creation?.status === 'pending') return
    const matching = [...rooms.values()].filter(({ map }) => map.id === transfer.mapId)
    const destination = matching.find((room) => room.hasCapacity())
    if (!destination) {
      if (matching.length) return failTransfer(route, 'MAP_SEAT_UNAVAILABLE', now)
      if (transfer.creation) return failTransfer(route, 'TRANSFER_FAILED', now)
      transfer.creation = createMissingRoom(transfer.mapId)
      return
    }
    try {
      const ticket = nextId()
      if (!destination.reserve(route.characterId)) return failTransfer(route, 'MAP_SEAT_UNAVAILABLE', now)
      transfer.destination = destination
      transfer.ticket = ticket
      tickets.set(ticket, route)
      route.peer?.offer({
        requestId: transfer.requestId,
        roomId: destination.roomId,
        mapId: transfer.mapId,
        mapEpoch: transfer.mapEpoch,
        ticket,
      })
    } catch {
      failTransfer(route, 'TRANSFER_FAILED', now)
    }
  }

  function commitTransfer(route: CharacterRoute, transfer: Transfer, frameTick: SimulationTick, now: number) {
    const { destination, candidate, spawn } = transfer
    const source = route.room
    const sourcePeer = route.peer
    if (!sourcePeer || !candidate || !destination || !registered(source) || !registered(destination)) {
      return failTransfer(route, 'TRANSFER_FAILED', now)
    }

    let binding
    let depart
    let arrive
    try {
      const body = source.player(route.characterId)
      if (!body) return failTransfer(route, 'TRANSFER_FAILED', now)
      const arrival =
        transfer.requestId === null
          ? respawnPlayer(body, frameTick, source.mapInstanceId, { ...spawn, mapId: destination.map.id, spawnId: spawn.id })?.player
          : {
              ...placePlayerAtSpawn(body, spawn.position, spawn.facing),
              spawnProtected: transfer.mapId !== 'village',
              spawnProtectionStartedTick: frameTick,
            }
      if (!arrival) return failTransfer(route, 'TRANSFER_FAILED', now)
      binding = { characterId: route.characterId, connectionEpoch: nextId(), mapEpoch: transfer.mapEpoch }
      depart = source.prepareDeparture(sourcePeer.connection, route.characterId)
      arrive = destination.prepareArrival(candidate.connection, binding, arrival, now)
    } catch {
      return failTransfer(route, 'TRANSFER_FAILED', now)
    }
    if (!depart || !arrive) return failTransfer(route, 'TRANSFER_FAILED', now)

    // 兩房尚未步進。提交只套用已備妥的狀態與索引。Transport 回呼在路由生效後才執行。
    depart()
    connections.delete(sourcePeer.connection)
    arrive()
    route.room = destination
    route.peer = candidate
    route.lastPortalRequestId = -1
    connections.set(candidate.connection, route)
    clearTransfer(route, true)
    notifyJoined(route, candidate, binding)
    closePeer(sourcePeer)
  }

  function advanceRoute(route: CharacterRoute, frameTick: SimulationTick, now: number): void {
    const { room, peer, characterId, transfer } = route
    if (!peer) {
      if (route.reconnectUntil !== undefined && now >= route.reconnectUntil) removeRoute(route)
      return
    }
    if (transfer) {
      if (now >= transfer.expiresAt) failTransfer(route, 'TRANSFER_EXPIRED', now)
      else if (transfer.canceled || (transfer.destination && !registered(transfer.destination))) failTransfer(route, 'TRANSFER_FAILED', now)
      else if (canAdmit()) {
        if (transfer.candidate) commitTransfer(route, transfer, frameTick, now)
        else if (!transfer.destination) prepareTransfer(route, transfer, now)
      }
      return
    }

    const request = route.portal
    route.portal = undefined
    const body = room.player(characterId)
    if (!body) {
      if (request) reportFailure(peer, { requestId: request.requestId, code: 'PORTAL_UNAVAILABLE' })
      return
    }
    let mapId: OnlineMapId
    let spawn: Spawn | undefined
    if (request) {
      const portal = canUseGroundedInteraction(body) && findOverlappingPortal(room.map, body.position)
      const target = portal && portal.destinationMapId
      if (!portal || request.objectId !== portal.id || (target !== 'm1' && target !== 'village')) {
        return reportFailure(peer, { requestId: request.requestId, code: 'PORTAL_UNAVAILABLE' })
      }
      mapId = target === 'm1' ? 'm1' : 'village'
      spawn = maps[mapId].spawns.find(({ id }) => id === portal.destinationSpawnId)
    } else {
      if (body.action.kind !== 'death' || now < route.nextRespawnMilliseconds) return
      const respawn = respawnPlayer(body, frameTick, room.mapInstanceId, {
        ...spawns.village,
        mapId: maps.village.id,
        spawnId: spawns.village.id,
      })
      if (!respawn) return
      if (room.map.id === 'village') return room.respawn(peer.connection, respawn.player)
      mapId = 'village'
      spawn = spawns.village
    }

    const requestId = request?.requestId ?? null
    if (!canAdmit()) {
      route.nextRespawnMilliseconds = now + respawnRetryMilliseconds
      return reportFailure(peer, { requestId, code: 'WORLD_TICK_BACKLOG' })
    }
    const mapEpoch = (room.binding(peer.connection)?.mapEpoch ?? Number.MAX_SAFE_INTEGER) + 1
    if (!spawn || !isNonNegativeSafeInteger(mapEpoch)) return reportFailure(peer, { requestId, code: 'TRANSFER_FAILED' })
    room.freeze(peer.connection)
    route.transfer = { requestId, mapId, spawn, mapEpoch, expiresAt: now + transferMilliseconds }
    prepareTransfer(route, route.transfer, now)
  }

  function start(): void {
    let wakeMilliseconds = clock.nowMilliseconds()
    const startMilliseconds = wakeMilliseconds
    const startTick = tick
    const driver = createFixedTickDriver(
      { nowMilliseconds: () => wakeMilliseconds },
      (frame) => {
        for (const route of routes.values()) advanceRoute(route, frame.tick, wakeMilliseconds)
        for (const id of [...rooms.keys()].sort()) rooms.get(id)?.advance(frame, wakeMilliseconds)
        tick = frame.tick
      },
      tick
    )
    stop = schedule(() => {
      wakeMilliseconds = clock.nowMilliseconds()
      catchingUp = wakeMilliseconds >= startMilliseconds + ((tick - startTick + maxCatchUpTicks + 1) * 1000) / ticksPerSecond
      const advance = driver.advance()
      catchingUp = false
      backlogTicks = advance.backlogTicks
      catchUpTicks += Math.max(0, advance.steps - 1)
      if (backlogStartedAt === undefined && backlogTicks > 0) {
        backlogStartedAt = wakeMilliseconds
        onBacklog(backlogTicks)
      } else if (backlogStartedAt !== undefined && backlogTicks === 0) {
        lastBacklogRecoveryMilliseconds = wakeMilliseconds - backlogStartedAt
        backlogStartedAt = undefined
        dependencies.onBacklogRecovered?.(lastBacklogRecoveryMilliseconds, catchUpTicks)
      }
    }, 1000 / ticksPerSecond)
  }

  function clearUnconfirmedToken(route: CharacterRoute) {
    if (!route.unconfirmedToken) return
    reconnectTokens.delete(route.unconfirmedToken)
    route.unconfirmedToken = undefined
  }

  function removeRoute(route: CharacterRoute) {
    const transfer = clearTransfer(route)
    routes.delete(route.characterId)
    reconnectTokens.delete(route.reconnectToken)
    clearUnconfirmedToken(route)
    if (route.peer) {
      connections.delete(route.peer.connection)
      route.room.leave(route.peer.connection)
    } else {
      route.room.release(route.characterId)
    }
    closePeer(transfer?.candidate)
  }

  function leave(room: MapRuntime, connection: object, dropped = false): void {
    const candidate = candidates.get(connection)
    if (candidate?.transfer?.destination === room) {
      candidate.transfer.canceled = true
      candidates.delete(connection)
      return
    }
    const route = connections.get(connection)
    if (!route || route.room !== room) return
    if (!dropped) return removeRoute(route)

    const transfer = clearTransfer(route)
    route.peer = undefined
    route.portal = undefined
    route.reconnectUntil = clock.nowMilliseconds() + reconnectMilliseconds
    connections.delete(connection)
    room.detach(connection)
    closePeer(transfer?.candidate)
  }

  function notifyJoined(route: CharacterRoute, peer: RoomPeer, binding: Omit<MapRoomSession, 'reconnectToken'>): void {
    try {
      peer.joined({ ...binding, reconnectToken: route.reconnectToken })
    } catch {
      // 入房確認可能遺失，從當前權威房間保留角色供重連。
      leave(route.room, peer.connection, true)
      closePeer(peer)
    }
  }

  return {
    clock,
    canAdmit,
    tickDiagnostics: () => ({ backlogTicks, catchUpTicks, lastBacklogRecoveryMilliseconds }),
    join(room: MapRuntime, peer: RoomPeer): boolean {
      if (!canAdmit() || !registered(room) || connections.has(peer.connection) || candidates.has(peer.connection)) return false
      const binding = room.join(peer.connection, clock.nowMilliseconds())
      if (!binding) return false
      const characterId = binding.characterId as CharacterId
      const reconnectToken = nextId()
      const route: CharacterRoute = {
        characterId,
        room,
        peer,
        reconnectToken,
        unconfirmedToken: undefined,
        reconnectUntil: undefined,
        lastPortalRequestId: -1,
        portal: undefined,
        transfer: undefined,
        nextRespawnMilliseconds: 0,
      }
      routes.set(characterId, route)
      connections.set(peer.connection, route)
      reconnectTokens.set(reconnectToken, route)
      peer.joined({ ...binding, reconnectToken })
      return true
    },
    acceptTransfer(room: MapRuntime, peer: RoomPeer, ticket: string, reconnectToken: string): boolean {
      const route = tickets.get(ticket)
      const transfer = route?.transfer
      if (
        !canAdmit() ||
        !route ||
        route.reconnectToken !== reconnectToken ||
        !transfer ||
        transfer.ticket !== ticket ||
        transfer.destination !== room ||
        !registered(room) ||
        transfer.candidate ||
        transfer.canceled ||
        clock.nowMilliseconds() >= transfer.expiresAt ||
        connections.has(peer.connection) ||
        candidates.has(peer.connection)
      )
        return false
      clearUnconfirmedToken(route)
      transfer.candidate = peer
      candidates.set(peer.connection, route)
      return true
    },
    reconnect(room: MapRuntime, peer: RoomPeer, token: string): boolean {
      const route = reconnectTokens.get(token)
      const now = clock.nowMilliseconds()
      if (
        !canAdmit() ||
        !route ||
        route.room !== room ||
        !registered(room) ||
        route.peer ||
        route.reconnectUntil === undefined ||
        now >= route.reconnectUntil ||
        connections.has(peer.connection) ||
        candidates.has(peer.connection)
      )
        return false
      const binding = room.rebind(route.characterId, peer.connection, now)
      if (!binding) return false
      reconnectTokens.delete(route.reconnectToken)
      clearUnconfirmedToken(route)
      // 第一個有效輸入確認新憑證已送達，之前只保留本次出示的憑證供掉線恢復。
      route.unconfirmedToken = token
      route.reconnectToken = nextId()
      reconnectTokens.set(token, route)
      reconnectTokens.set(route.reconnectToken, route)
      route.peer = peer
      route.reconnectUntil = undefined
      route.lastPortalRequestId = -1
      connections.set(peer.connection, route)
      notifyJoined(route, peer, binding)
      return true
    },
    requestPortal(room: MapRuntime, connection: object, payload: unknown): boolean {
      const route = connections.get(connection)
      const request = parsePortalRequest(payload)
      if (
        !route ||
        route.room !== room ||
        !request ||
        route.transfer ||
        route.portal ||
        room.binding(connection)?.mapEpoch !== request.mapEpoch ||
        request.requestId <= route.lastPortalRequestId
      )
        return false
      route.lastPortalRequestId = request.requestId
      route.portal = request
      clearUnconfirmedToken(route)
      return true
    },
    cancelTransfer(room: MapRuntime, connection: object, ticket: string): void {
      const route = connections.get(connection)
      if (route?.room === room && route.transfer?.ticket === ticket) route.transfer.canceled = true
    },
    leave,
    receive(room: MapRuntime, connection: object, payload: unknown): boolean {
      const route = connections.get(connection)
      if (route?.room !== room || !room.receive(connection, payload, clock.nowMilliseconds())) return false
      clearUnconfirmedToken(route)
      return true
    },
    checkpoint(room: MapRuntime, connection: object) {
      if (connections.get(connection)?.room === room) return room.checkpoint(connection)
    },
    createRoom(mapId: OnlineMapId = 'm1', roomId?: string): MapRuntime {
      const mapInstanceId = `${bootId}:${mapId}:${++instanceSequence}` as MapInstanceId
      const room = createMapRuntime(
        mapInstanceId,
        maps[mapId],
        spawns[mapId],
        mapContentHash,
        tick,
        nextId,
        mapId === 'm1' ? fixture : undefined,
        roomId
      )
      rooms.set(mapInstanceId, room)
      if (!stop) start()
      return room
    },
    disposeRoom(room: MapRuntime): void {
      if (!registered(room)) return
      rooms.delete(room.mapInstanceId)
      for (const route of routes.values()) {
        if (route.room === room) removeRoute(route)
        else if (route.transfer?.destination === room) route.transfer.canceled = true
      }
      room.dispose()
      if (rooms.size === 0) {
        stop?.()
        stop = undefined
        backlogTicks = 0
        backlogStartedAt = undefined
      }
    },
  }
}

export type WorldCoordinator = ReturnType<typeof createWorldCoordinator>
