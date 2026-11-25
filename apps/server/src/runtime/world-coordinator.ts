import {
  attributeNames,
  isNonNegativeSafeInteger,
  toSimulationTick,
  type CharacterAggregate,
  type CharacterId,
  type DeathId,
  type DerivedCombatStats,
  type MapInstanceId,
  type SimulationTick,
} from '@viesma/domain'
import { deriveCombatStats, getStarterWeaponModifiers, initialBaseAttributes, type GameData, type NormalizedMap } from '@viesma/game-data'
import {
  parseAllocateAp,
  parsePortalRequest,
  PROTOCOL_VERSION,
  readApRequestId,
  type AllocateApRequest,
  type ApResultCode,
  type MapRoomJoin,
  type MapRoomSession,
  type OnlineMapId,
  type OwnerProgression,
  type PortalRequest,
  type TransferFailure,
  type TransferOffer,
} from '@viesma/protocol'
import {
  allocateAttributes,
  allocateSoloExperience,
  canUseGroundedInteraction,
  createCharacterAggregate,
  createFixedTickDriver,
  findOverlappingPortal,
  grantExperience,
  maxCatchUpTicks,
  placePlayerAtSpawn,
  respawnPlayer,
  ticksPerSecond,
  type EncounterRewardIntent,
  type MonotonicClock,
  type PartyMembership,
} from '@viesma/simulation'
import { createEncounterRewardWorker, type EncounterRewardPort } from './encounter-reward-worker.ts'
import { createMapRuntime, type MapRuntime } from './map-runtime.ts'
import { getMonsterSpawnDefinitions } from './monster-spawns.ts'
import type { WatchMovement } from './movement-trace.ts'

interface WorldDependencies {
  readonly clock: MonotonicClock
  readonly schedule: (wake: () => void, intervalMilliseconds: number) => () => void
  readonly nextId: () => string
  readonly onBacklog: (backlogTicks: number) => void
  readonly onBacklogRecovered?: (recoveryMilliseconds: number, catchUpTicks: number) => void
  readonly createDestination?: (mapId: OnlineMapId) => Promise<unknown>
  readonly partyMembership?: (characterId: CharacterId) => PartyMembership | undefined
  readonly rewardPort?: EncounterRewardPort
  readonly watchMovement?: WatchMovement
}

export interface RoomPeer {
  readonly connection: object
  readonly joined: (session: MapRoomSession) => void
  readonly offer: (offer: TransferOffer) => void
  readonly failed: (failure: TransferFailure) => void
  readonly progression?: (snapshot: OwnerProgression) => void
  readonly close: () => void
}

interface CharacterProgression {
  aggregate: CharacterAggregate
  stats: DerivedCombatStats
  readonly grantedDeaths: Set<DeathId>
}

interface ApCommand {
  readonly request: AllocateApRequest
  result?: ApResultCode
}

interface CharacterRoute {
  readonly characterId: CharacterId
  readonly progression: CharacterProgression
  reconnectToken: string
  unconfirmedToken: string | undefined
  room: MapRuntime
  peer: RoomPeer | undefined
  reconnectUntil: number | undefined
  lastPortalRequestId: number
  portal: PortalRequest | undefined
  transfer: Transfer | undefined
  apCommand?: ApCommand
  nextRespawnMilliseconds: number
}

type Spawn = NormalizedMap['spawns'][number]
type Creation = { status: 'pending' | 'failed' | 'created' }
type TransferCause =
  { readonly requestId: number; readonly diedAtTick?: never } | { readonly requestId: null; readonly diedAtTick: SimulationTick }
type Transfer = TransferCause & {
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
  const starterModifiers = getStarterWeaponModifiers(data)
  const starterStats = deriveCombatStats(1, initialBaseAttributes, starterModifiers)
  const monsterSpawns = {
    m1: { definitions: getMonsterSpawnDefinitions(data, m1), maxActive: data.world.maxMonstersPerMap },
    village: { definitions: getMonsterSpawnDefinitions(data, village), maxActive: data.world.maxMonstersPerMap },
  }

  const { clock, schedule, nextId, onBacklog, createDestination } = dependencies
  const rewards = createEncounterRewardWorker(dependencies.rewardPort, prepareSoloReward)
  const combat = {
    playerStats: (characterId: CharacterId) => routes.get(characterId)?.progression.stats ?? starterStats,
    balanceVersion: data.balanceVersion,
    rewards,
    ...(dependencies.partyMembership && { partyMembership: dependencies.partyMembership }),
  }
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

  function commitProgression(progression: CharacterProgression, aggregate: CharacterAggregate, stats: DerivedCombatStats): void {
    progression.aggregate = aggregate
    progression.stats = stats
    routes.get(aggregate.characterId)?.room.updatePlayerMaxima(aggregate.characterId, stats)
  }

  function prepareSoloReward({ claim, groups }: EncounterRewardIntent) {
    const { deathId, mapId, spawnId } = claim
    const definitions = mapId === maps.m1.id ? monsterSpawns.m1.definitions : monsterSpawns.village.definitions
    const baseExp = definitions.find((spawn) => spawn.spawnId === spawnId)?.baseExp
    const grants = allocateSoloExperience(baseExp ?? 0, groups).flatMap(({ characterId, exp }) => {
      const progression = routes.get(characterId)?.progression
      return progression ? [{ progression, exp }] : []
    })
    // 保留死亡時已接受的授予目標，來源房與目前綁定可在 receipt 到達前消失。
    return () => {
      const changes = grants.flatMap(({ progression, exp }) => {
        if (progression.grantedDeaths.has(deathId)) return []
        const aggregate = grantExperience(progression.aggregate, exp, data.progression)
        if (aggregate === progression.aggregate) return []
        const stats = deriveCombatStats(aggregate.level, aggregate.baseAttributes, starterModifiers)
        return [{ progression, aggregate, stats }]
      })
      for (const { progression, aggregate, stats } of changes) {
        commitProgression(progression, aggregate, stats)
        if (aggregate.level === data.progression.levelCap) progression.grantedDeaths.clear()
        else progression.grantedDeaths.add(deathId)
      }
      return Object.freeze(changes.map(({ aggregate: { characterId, version } }) => Object.freeze({ characterId, version })))
    }
  }

  function progressionSnapshot(route: CharacterRoute, binding: MapRoomJoin, result?: OwnerProgression['result']): OwnerProgression {
    const { aggregate, stats } = route.progression
    const { version, level, expWithinLevel, unspentAp, baseAttributes } = aggregate
    return {
      ...binding,
      protocolVersion: PROTOCOL_VERSION,
      characterVersion: version,
      level,
      expWithinLevel,
      nextLevelExp: data.progression.expToNextLevel[level - 1] ?? null,
      unspentAp,
      baseAttributes,
      stats,
      ...(result && { result }),
    }
  }

  function reportAp(route: CharacterRoute, binding: MapRoomJoin, requestId: number, code: ApResultCode): void {
    try {
      route.peer?.progression?.(progressionSnapshot(route, binding, { requestId, code }))
    } catch {
      // 結案已留存；重送或重連可取得權威快照。
    }
  }

  function matchesBinding(binding: MapRoomJoin, request: AllocateApRequest): boolean {
    return request.connectionEpoch === binding.connectionEpoch && request.mapEpoch === binding.mapEpoch
  }

  function canAllocateAp(route: CharacterRoute): boolean {
    const body = route.room.player(route.characterId)
    return !route.transfer && body !== undefined && body.action.kind !== 'death' && body.vitals.hp > 0
  }

  function advanceAp(route: CharacterRoute): void {
    const { peer, room, apCommand, progression } = route
    if (!peer || !apCommand || apCommand.result) return
    const binding = room.binding(peer.connection)
    const { request } = apCommand
    if (!binding || !matchesBinding(binding, request)) return

    function allocate(): ApResultCode {
      if (!canAllocateAp(route)) return 'UNAVAILABLE'
      if (request.expectedCharacterVersion !== progression.aggregate.version) return 'STALE_VERSION'
      const result = allocateAttributes(progression.aggregate, request.deltas)
      if ('code' in result) return result.code
      if (result.character !== progression.aggregate) {
        const { level, baseAttributes } = result.character
        commitProgression(progression, result.character, deriveCombatStats(level, baseAttributes, starterModifiers))
      }
      return 'CONFIRMED'
    }

    apCommand.result = allocate()
    reportAp(route, binding, request.requestId, apCommand.result)
  }

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
      if (matching.length && (transfer.requestId !== null || transfer.creation)) {
        return failTransfer(route, 'MAP_SEAT_UNAVAILABLE', now)
      }
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
      if (!body || (body.action.kind === 'death' ? body.action.diedAtTick : undefined) !== transfer.diedAtTick) {
        return failTransfer(route, 'TRANSFER_FAILED', now)
      }
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
    const body = room.player(characterId)
    if (transfer && transfer.requestId !== null && body?.action.kind === 'death') {
      failTransfer(route, 'PORTAL_UNAVAILABLE', now)
      route.nextRespawnMilliseconds = now
    } else if (transfer) {
      if (now >= transfer.expiresAt) failTransfer(route, 'TRANSFER_EXPIRED', now)
      else if (transfer.canceled || (transfer.destination && !registered(transfer.destination))) failTransfer(route, 'TRANSFER_FAILED', now)
      else if (canAdmit()) {
        if (transfer.candidate) commitTransfer(route, transfer, frameTick, now)
        else if (!transfer.destination) prepareTransfer(route, transfer, now)
      }
      return
    }

    let request = route.portal
    route.portal = undefined
    if (!body) {
      if (request) reportFailure(peer, { requestId: request.requestId, code: 'PORTAL_UNAVAILABLE' })
      return
    }
    const diedAtTick = body.action.kind === 'death' ? body.action.diedAtTick : undefined
    if (request && diedAtTick !== undefined) {
      reportFailure(peer, { requestId: request.requestId, code: 'PORTAL_UNAVAILABLE' })
      request = undefined
    }
    let mapId: OnlineMapId
    let spawn: Spawn | undefined
    let cause: TransferCause
    if (request) {
      const portal = canUseGroundedInteraction(body) && findOverlappingPortal(room.map, body.position)
      const target = portal && portal.destinationMapId
      if (!portal || request.objectId !== portal.id || (target !== 'm1' && target !== 'village')) {
        return reportFailure(peer, { requestId: request.requestId, code: 'PORTAL_UNAVAILABLE' })
      }
      mapId = target === 'm1' ? 'm1' : 'village'
      spawn = maps[mapId].spawns.find(({ id }) => id === portal.destinationSpawnId)
      cause = { requestId: request.requestId }
    } else {
      if (diedAtTick === undefined || now < route.nextRespawnMilliseconds) return
      const respawn = respawnPlayer(body, frameTick, room.mapInstanceId, {
        ...spawns.village,
        mapId: maps.village.id,
        spawnId: spawns.village.id,
      })
      if (!respawn) return
      if (room.map.id === 'village') return room.respawn(peer.connection, respawn.player)
      mapId = 'village'
      spawn = spawns.village
      cause = { requestId: null, diedAtTick }
    }

    const { requestId } = cause
    if (!canAdmit()) {
      route.nextRespawnMilliseconds = now + respawnRetryMilliseconds
      return reportFailure(peer, { requestId, code: 'WORLD_TICK_BACKLOG' })
    }
    const mapEpoch = (room.binding(peer.connection)?.mapEpoch ?? Number.MAX_SAFE_INTEGER) + 1
    if (!spawn || !isNonNegativeSafeInteger(mapEpoch)) return reportFailure(peer, { requestId, code: 'TRANSFER_FAILED' })
    room.freeze(peer.connection)
    route.transfer = { ...cause, mapId, spawn, mapEpoch, expiresAt: now + transferMilliseconds }
    prepareTransfer(route, route.transfer, now)
  }

  function stopIfIdle(): void {
    if (rooms.size > 0 || rewards.hasPending()) return
    stop?.()
    stop = undefined
    backlogTicks = 0
    backlogStartedAt = undefined
  }

  function start(): void {
    let wakeMilliseconds = clock.nowMilliseconds()
    const startMilliseconds = wakeMilliseconds
    const startTick = tick
    const driver = createFixedTickDriver(
      { nowMilliseconds: () => wakeMilliseconds },
      (frame) => {
        rewards.advance()
        for (const route of routes.values()) {
          advanceRoute(route, frame.tick, wakeMilliseconds)
          advanceAp(route)
        }
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
      stopIfIdle()
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
        progression: { aggregate: createCharacterAggregate(characterId), stats: starterStats, grantedDeaths: new Set() },
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
      const action = route?.room.player(route.characterId)?.action
      if (
        !canAdmit() ||
        !route ||
        route.reconnectToken !== reconnectToken ||
        !transfer ||
        !action ||
        (action.kind === 'death' ? action.diedAtTick : undefined) !== transfer.diedAtTick ||
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
    requestAp(room: MapRuntime, connection: object, payload: unknown): void {
      const route = connections.get(connection)
      const binding = route?.room === room ? room.binding(connection) : undefined
      const requestId = readApRequestId(payload)
      if (!route || !binding || requestId === undefined) return
      const request = parseAllocateAp(payload)
      if (!request) return reportAp(route, binding, requestId, 'INVALID_ALLOCATION')
      if (!matchesBinding(binding, request)) return reportAp(route, binding, requestId, 'STALE_BINDING')

      const latest = route.apCommand
      if (latest && matchesBinding(binding, latest.request)) {
        if (requestId < latest.request.requestId) return reportAp(route, binding, requestId, 'STALE_REQUEST')
        if (requestId === latest.request.requestId) {
          const same =
            latest.request.expectedCharacterVersion === request.expectedCharacterVersion &&
            attributeNames.every((name) => latest.request.deltas[name] === request.deltas[name])
          if (!same) return reportAp(route, binding, requestId, 'REQUEST_CONFLICT')
          if (latest.result) reportAp(route, binding, requestId, latest.result)
          return
        }
        if (!latest.result) return reportAp(route, binding, requestId, 'BUSY')
      }
      if (!canAllocateAp(route)) {
        route.apCommand = { request, result: 'UNAVAILABLE' }
        return reportAp(route, binding, requestId, 'UNAVAILABLE')
      }
      route.apCommand = { request }
      clearUnconfirmedToken(route)
    },
    progression(room: MapRuntime, connection: object, afterVersion = -1): OwnerProgression | undefined {
      const route = connections.get(connection)
      const binding = route?.room === room ? room.binding(connection) : undefined
      if (route && binding && route.progression.aggregate.version > afterVersion) return progressionSnapshot(route, binding)
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
        monsterSpawns[mapId],
        roomId,
        combat,
        dependencies.watchMovement
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
      stopIfIdle()
    },
  }
}

export type WorldCoordinator = ReturnType<typeof createWorldCoordinator>
