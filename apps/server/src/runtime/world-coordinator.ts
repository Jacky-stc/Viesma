import {
  isNonNegativeSafeInteger,
  toSimulationTick,
  type BagItem,
  type CharacterCommandCode,
  type CharacterId,
  type MapInstanceId,
  type SimulationTick,
} from '@viesma/domain'
import {
  consumableCooldownTicks,
  deriveCombatStats,
  getStarterWeaponModifiers,
  initialBaseAttributes,
  type GameData,
  type NormalizedMap,
} from '@viesma/game-data'
import {
  isApResultCode,
  isEquipmentResultCode,
  isLootResultCode,
  parseAllocateAp,
  parseEquipmentRequest,
  parseGroundLootRefresh,
  parseGroundLootRequest,
  parsePortalRequest,
  PROTOCOL_VERSION,
  readCharacterRequestId,
  type CharacterRequestHeader,
  type InventoryItemView,
  type LootResultCode,
  type MapRoomJoin,
  type MapRoomSession,
  type OnlineMapId,
  type OwnerGroundLoot,
  type OwnerInventory,
  type OwnerLootCommandResult,
  type OwnerProgression,
  type PortalRequest,
  type TransferFailure,
  type TransferOffer,
} from '@viesma/protocol'
import {
  allocateSoloExperience,
  canUseGroundedInteraction,
  createFixedTickDriver,
  findOverlappingPortal,
  maxCatchUpTicks,
  parseInventoryGrant,
  placePlayerAtSpawn,
  playerFeet,
  respawnPlayer,
  ticksPerSecond,
  type EncounterRewardIntent,
  type InventoryGrant,
  type MonotonicClock,
  type PartyMembership,
} from '@viesma/simulation'
import { createCharacterCoordinator, makeCharacterRequest, type CharacterRequest } from './character-coordinator.ts'
import { createEncounterRewardWorker, type EncounterRewardPort } from './encounter-reward-worker.ts'
import { createGroundLootStore, type CommittedLootRoll, type GroundLootState } from './ground-loot.ts'
import { createMapRuntime, type MapRuntime } from './map-runtime.ts'
import { createMemoryCharacterRepository, type ConsumableEffect } from './memory-character-repository.ts'
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
  readonly nowUtcMilliseconds?: () => number
  readonly characterRepositoryFactory?: typeof createMemoryCharacterRepository
}

export interface RoomPeer {
  readonly connection: object
  readonly joined: (session: MapRoomSession) => void
  readonly offer: (offer: TransferOffer) => void
  readonly failed: (failure: TransferFailure) => void
  readonly progression?: (snapshot: OwnerProgression) => void
  readonly inventory?: (snapshot: OwnerInventory) => void
  readonly lootResult?: (result: OwnerLootCommandResult) => void
  readonly close: () => void
}

type CommandKind = 'ap' | 'equipment' | 'pickup' | 'consume'
type ConsumeAdmission =
  | { readonly code: CharacterCommandCode }
  | {
      readonly effect: Omit<ConsumableEffect, 'dueTick'>
      readonly readyAtTick: number
    }
type QueuedRequest = {
  readonly kind: 'request'
  readonly commandKind: CommandKind
  readonly header: CharacterRequestHeader
  readonly request: CharacterRequest
  readonly consume?: ConsumeAdmission
}
interface CommittedConsumable {
  readonly request: CharacterRequest
  readonly requestId: number
  readonly requestEpoch: string
}
type CharacterCommand =
  | QueuedRequest
  | {
      readonly kind: 'grant'
      readonly grantId: string
      readonly grant: InventoryGrant
      readonly complete: (code: CharacterCommandCode) => void
    }

interface CharacterRoute {
  readonly characterId: CharacterId
  readonly commands: CharacterCommand[]
  lastCommandId: number
  reconnectToken: string
  unconfirmedToken: string | undefined
  room: MapRuntime
  peer: RoomPeer | undefined
  reconnectUntil: number | undefined
  lastPortalRequestId: number
  portal: PortalRequest | undefined
  transfer: Transfer | undefined
  nextRespawnMilliseconds: number
  consumableReadyAtTick: number
  pendingConsumable: CommittedConsumable | undefined
}

export interface GroundLootFeed {
  readonly binding: MapRoomJoin
  readonly mapInstanceId: MapInstanceId
  readonly state: GroundLootState
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
  const starterStats = deriveCombatStats(1, initialBaseAttributes, getStarterWeaponModifiers(data))
  const monsterSpawns = {
    m1: { definitions: getMonsterSpawnDefinitions(data, m1), maxActive: data.world.maxMonstersPerMap },
    village: { definitions: getMonsterSpawnDefinitions(data, village), maxActive: data.world.maxMonstersPerMap },
  }

  const {
    clock,
    schedule,
    nextId,
    onBacklog,
    createDestination,
    nowUtcMilliseconds = Date.now,
    characterRepositoryFactory = createMemoryCharacterRepository,
  } = dependencies
  const ground = createGroundLootStore(data.tiledMaps)
  const consumables = new Map(data.items.filter((item) => item.kind === 'consumable').map((item) => [item.id, item]))
  const characters = createCharacterCoordinator(
    data,
    (characterId, stats) => {
      routes.get(characterId)?.room.updatePlayerMaxima(characterId, stats)
    },
    characterRepositoryFactory(data.items, { store: ground, nowUtcMilliseconds })
  )
  const rewards = createEncounterRewardWorker(dependencies.rewardPort, prepareSoloReward)
  const combat = {
    playerStats: (characterId: CharacterId) => {
      const character = characters.read(characterId)
      return character ? characters.stats(character) : starterStats
    },
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

  function prepareSoloReward({ claim, groups }: EncounterRewardIntent) {
    const { deathId, mapId, spawnId } = claim
    const definitions = mapId === maps.m1.id ? monsterSpawns.m1.definitions : monsterSpawns.village.definitions
    const baseExp = definitions.find((spawn) => spawn.spawnId === spawnId)?.baseExp
    const grants = allocateSoloExperience(baseExp ?? 0, groups).flatMap(({ characterId, exp }) => {
      const commit = routes.has(characterId) && characters.retainExperience(characterId, deathId, exp)
      return commit ? [commit] : []
    })
    return () =>
      Object.freeze(
        grants.flatMap((commit) => {
          const version = commit()
          return version ? [version] : []
        })
      )
  }

  function progressionSnapshot(route: CharacterRoute, binding: MapRoomJoin, result?: OwnerProgression['result']): OwnerProgression {
    const aggregate = characters.read(route.characterId)
    if (!aggregate) throw new Error('Missing active character')
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
      stats: characters.stats(aggregate),
      ...(result && { result }),
    }
  }

  function inventorySnapshot(route: CharacterRoute, binding: MapRoomJoin, result?: OwnerInventory['result']): OwnerInventory {
    const character = characters.read(route.characterId)
    if (!character) throw new Error('Missing active character')
    const { bag, equipment, currency } = character.inventory
    function view(item: BagItem | null): InventoryItemView | null {
      if (!item) return null
      const { itemDefinitionId, quantity } = item
      return item.kind === 'equipment'
        ? { itemDefinitionId, quantity, itemInstanceId: item.itemInstanceId }
        : { itemDefinitionId, quantity }
    }
    return {
      ...binding,
      protocolVersion: PROTOCOL_VERSION,
      characterVersion: character.version,
      bag: bag.map(view),
      currency,
      equipment: { weapon: view(equipment.weapon), armor: view(equipment.armor), accessory: view(equipment.accessory) },
      ...(result && { result }),
    }
  }

  function reportCommand(
    route: CharacterRoute,
    binding: MapRoomJoin,
    kind: CommandKind,
    requestId: number,
    code: CharacterCommandCode | LootResultCode,
    requestEpoch?: string
  ): void {
    const identity = { requestId, ...(requestEpoch !== undefined && { requestEpoch }) }
    try {
      if (kind === 'ap' && isApResultCode(code)) route.peer?.progression?.(progressionSnapshot(route, binding, { ...identity, code }))
      if (kind === 'equipment' && isEquipmentResultCode(code))
        route.peer?.inventory?.(inventorySnapshot(route, binding, { ...identity, code }))
      if ((kind === 'pickup' || kind === 'consume') && isLootResultCode(code))
        route.peer?.lootResult?.({
          ...binding,
          protocolVersion: PROTOCOL_VERSION,
          mapInstanceId: route.room.mapInstanceId,
          kind,
          requestId,
          requestEpoch: requestEpoch ?? binding.connectionEpoch,
          code,
        })
    } catch {
      // 收據與角色狀態已提交，下一次重送可讀取目前快照。
    }
  }

  function matchesBinding(binding: MapRoomJoin, request: Pick<MapRoomJoin, 'connectionEpoch' | 'mapEpoch'>): boolean {
    return request.connectionEpoch === binding.connectionEpoch && request.mapEpoch === binding.mapEpoch
  }

  function canMutate(route: CharacterRoute, kind: CommandKind): boolean {
    const body = route.room.player(route.characterId)
    return (
      !route.transfer &&
      body !== undefined &&
      body.action.kind !== 'death' &&
      body.vitals.hp > 0 &&
      (kind === 'equipment' ? canUseGroundedInteraction(body) : kind === 'ap' || !body.physics.inVoid)
    )
  }

  function admitConsumable(route: CharacterRoute, request: CharacterRequest): ConsumeAdmission {
    const { operation, expectedCharacterVersion } = request
    const body = route.room.player(route.characterId)
    const state = characters.read(route.characterId)
    if (operation.kind !== 'consume' || !body || !state || !canMutate(route, 'consume')) return { code: 'UNAVAILABLE' }
    if (state.version !== expectedCharacterVersion) return { code: 'STALE_VERSION' }
    const item = consumables.get(operation.itemDefinitionId)
    if (!item) return { code: 'INVALID_ITEM' }
    const source = state.inventory.bag[operation.bagSlot]
    if (source?.kind !== 'stack' || source.itemDefinitionId !== item.id || source.quantity <= 0) return { code: 'SOURCE_CHANGED' }
    if (
      tick < route.consumableReadyAtTick ||
      route.commands.some((command) => command.kind === 'request' && command.consume && 'effect' in command.consume)
    )
      return { code: 'COOLDOWN' }
    const { resource, restoreAmount } = item
    if (body.vitals[resource] >= (resource === 'hp' ? body.vitals.maxHp : body.vitals.maxMp)) return { code: 'RESOURCE_FULL' }
    return {
      effect: { kind: resource === 'hp' ? 'heal' : 'restoreMp', amount: restoreAmount, lifeStartedTick: body.lifeStartedTick },
      readyAtTick: tick + consumableCooldownTicks,
    }
  }

  function advanceConsumable(route: CharacterRoute, frameTick: SimulationTick): void {
    const pending = route.pendingConsumable
    if (!pending || routes.get(route.characterId) !== route) return
    const effect = characters.consumableEffect(route.characterId, pending.request)
    if (effect && frameTick < effect.dueTick) return
    route.pendingConsumable = undefined
    if (!effect) return
    const code = route.room.applyConsumable(route.characterId, effect, frameTick)
    characters.finishConsumable(route.characterId, pending.request.key, code)

    const connection = route.peer?.connection
    const binding = connection && connections.get(connection) === route ? route.room.binding(connection) : undefined
    if (binding?.characterId === route.characterId) reportCommand(route, binding, 'consume', pending.requestId, code, pending.requestEpoch)
  }

  function commandAdmission(route: CharacterRoute, command: QueuedRequest, frameTick: SimulationTick) {
    const {
      request: { operation },
      commandKind,
      consume,
    } = command
    const available = canMutate(route, commandKind)
    if (consume && 'code' in consume) return consume
    if (!available) return false
    const body = route.room.player(route.characterId)
    if (operation.kind === 'pickup' && body) {
      const grant = ground.inspectPickup(
        operation.lootId,
        route.characterId,
        route.room.mapInstanceId,
        playerFeet(body),
        nowUtcMilliseconds()
      )
      return 'delivery' in grant ? { pickup: grant.delivery } : grant
    }
    if (consume && body?.lifeStartedTick === consume.effect.lifeStartedTick)
      return { effect: { ...consume.effect, dueTick: toSimulationTick(frameTick + 1) } }
    return !consume
  }

  function advanceCommands(route: CharacterRoute, frameTick: SimulationTick): void {
    for (const command of route.commands.splice(0)) {
      if (command.kind === 'grant') {
        try {
          command.complete(characters.insert(route.characterId, command.grantId, command.grant))
        } catch {
          command.complete('BUSY')
        }
        continue
      }
      const binding = route.peer && route.room.binding(route.peer.connection)
      if (!binding || !matchesBinding(binding, command.header)) continue
      const { header, request, commandKind: kind, consume } = command
      let code: CharacterCommandCode
      try {
        code = characters.execute(route.characterId, request, commandAdmission(route, command, frameTick))
      } catch {
        code = 'BUSY'
      }
      if (code === 'CONFIRMED' && consume && 'effect' in consume && characters.consumableEffect(route.characterId, request)) {
        route.pendingConsumable = { request, requestId: header.requestId, requestEpoch: header.requestEpoch ?? header.connectionEpoch }
        route.consumableReadyAtTick = consume.readyAtTick
        continue
      }
      reportCommand(route, binding, kind, header.requestId, code, header.requestEpoch)
    }
  }

  function requestCommand(room: MapRuntime, connection: object, payload: unknown, kind: CommandKind): void {
    const route = connections.get(connection)
    const binding = route?.room === room ? room.binding(connection) : undefined
    const requestId = readCharacterRequestId(payload)
    if (!route || !binding || requestId === undefined) return
    const header =
      kind === 'ap'
        ? parseAllocateAp(payload)
        : kind === 'equipment'
          ? parseEquipmentRequest(payload)
          : parseGroundLootRequest(payload, kind)
    const report = (code: CharacterCommandCode | LootResultCode) =>
      reportCommand(route, binding, kind, requestId, code, header?.requestEpoch)
    if (!header) return report(kind === 'ap' ? 'INVALID_ALLOCATION' : 'INVALID_ITEM')
    if (!matchesBinding(binding, header)) return report('STALE_BINDING')

    const scope = header.requestEpoch ?? header.connectionEpoch
    const operation = 'deltas' in header ? { kind: 'ap' as const, deltas: header.deltas } : header
    const request = makeCharacterRequest(scope, requestId, header.expectedCharacterVersion, operation)
    const receipt = characters.replay(route.characterId, request.key, request.fingerprint)
    if (receipt) {
      if (kind === 'consume' && receipt === 'CONFIRMED') return report(characters.consumableOutcome(route.characterId, request))
      // 保留舊 AP 呼叫對已汰換失敗請求的回覆。顯式重送始終依原始收據結案。
      return report(
        header.requestEpoch === undefined &&
          kind === 'ap' &&
          requestId < route.lastCommandId &&
          receipt !== 'CONFIRMED' &&
          receipt !== 'REQUEST_CONFLICT'
          ? 'STALE_REQUEST'
          : receipt
      )
    }
    const existing = route.commands.find((command) => command.kind === 'request' && command.request.key === request.key)
    if (existing?.kind === 'request') {
      if (existing.request.fingerprint !== request.fingerprint) report('REQUEST_CONFLICT')
      else if (kind === 'pickup' || kind === 'consume') report('PENDING')
      return
    }
    if (scope !== binding.connectionEpoch || requestId < route.lastCommandId) return report('STALE_REQUEST')
    const consume = kind === 'consume' ? admitConsumable(route, request) : undefined
    const sameKind = route.commands.filter(
      (command): command is QueuedRequest => command.kind === 'request' && command.commandKind === kind
    )
    if (
      sameKind.length &&
      !(
        sameKind.length === 1 &&
        consume &&
        'code' in consume &&
        consume.code === 'COOLDOWN' &&
        sameKind[0]?.consume &&
        'effect' in sameKind[0].consume
      )
    ) {
      return report('BUSY')
    }
    route.lastCommandId = requestId
    route.commands.push({ kind: 'request', commandKind: kind, header, request, ...(consume && { consume }) })
    clearUnconfirmedToken(route)
    if (kind === 'pickup' || kind === 'consume') report('PENDING')
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
    route.lastCommandId = -1
    connections.set(candidate.connection, route)
    clearTransfer(route, true)
    ground.rebind(route.characterId, destination.map.id, destination.mapInstanceId, (id) => rooms.has(id), nowUtcMilliseconds)
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
        ground.expire(nowUtcMilliseconds)
        for (const route of routes.values()) {
          advanceRoute(route, frame.tick, wakeMilliseconds)
          advanceConsumable(route, frame.tick)
          advanceCommands(route, frame.tick)
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
    const pending = route.pendingConsumable
    route.pendingConsumable = undefined
    if (pending) characters.finishConsumable(route.characterId, pending.request.key, 'CONSUMED_NO_EFFECT')
    characters.release(route.characterId)
    for (const command of route.commands.splice(0)) if (command.kind === 'grant') command.complete('UNAVAILABLE')
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
      characters.open(characterId)
      const reconnectToken = nextId()
      const route: CharacterRoute = {
        characterId,
        commands: [],
        lastCommandId: -1,
        room,
        peer,
        reconnectToken,
        unconfirmedToken: undefined,
        reconnectUntil: undefined,
        lastPortalRequestId: -1,
        portal: undefined,
        transfer: undefined,
        nextRespawnMilliseconds: 0,
        consumableReadyAtTick: 0,
        pendingConsumable: undefined,
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
      route.lastCommandId = -1
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
      requestCommand(room, connection, payload, 'ap')
    },
    requestEquipment(room: MapRuntime, connection: object, payload: unknown): void {
      requestCommand(room, connection, payload, 'equipment')
    },
    requestGroundLoot(room: MapRuntime, connection: object, payload: unknown, kind: 'pickup' | 'consume'): void {
      requestCommand(room, connection, payload, kind)
    },
    deliverCommittedGroundLoot(room: MapRuntime, grants: readonly CommittedLootRoll[]): void {
      if (!registered(room)) throw new RangeError('Ground delivery requires a registered source room')
      ground.prepareDelivery(grants, room.map.id, room.mapInstanceId, nowUtcMilliseconds())()
    },
    ownerGroundLoot(room: MapRuntime, connection: object, previous?: GroundLootFeed, refresh?: unknown) {
      const route = connections.get(connection)
      const binding = route?.room === room && route.peer?.connection === connection ? room.binding(connection) : undefined
      if (!route || !binding || binding.characterId !== route.characterId || !registered(room)) return
      if (refresh !== undefined) {
        const request = parseGroundLootRefresh(refresh)
        if (
          !request ||
          request.characterId !== binding.characterId ||
          !matchesBinding(binding, request) ||
          request.mapInstanceId !== room.mapInstanceId
        )
          return
      }
      const state = ground.view(route.characterId, room.mapInstanceId)
      const feed: GroundLootFeed = { binding, mapInstanceId: room.mapInstanceId, state }
      const common = { ...binding, protocolVersion: PROTOCOL_VERSION, mapInstanceId: room.mapInstanceId, privateRevision: state.revision }
      let update: OwnerGroundLoot
      if (
        !previous ||
        previous.mapInstanceId !== room.mapInstanceId ||
        previous.binding.characterId !== binding.characterId ||
        !matchesBinding(binding, previous.binding) ||
        refresh !== undefined
      ) {
        update = { ...common, kind: 'snapshot', loot: [...state.loot.values()] }
      } else {
        if (previous.state.revision === state.revision) return
        update = {
          ...common,
          kind: 'delta',
          baseRevision: previous.state.revision,
          added: [...state.loot.values()].filter(({ lootId }) => !previous.state.loot.has(lootId)),
          removed: [...previous.state.loot.keys()].filter((id) => !state.loot.has(id)),
        }
      }
      return { feed, update }
    },
    queueInventoryGrant(characterId: CharacterId, grantId: string, grant: InventoryGrant): Promise<CharacterCommandCode> {
      const route = routes.get(characterId)
      if (!route) return Promise.resolve('UNAVAILABLE')
      const normalized = parseInventoryGrant(grant)
      if (!normalized) return Promise.resolve('INVALID_ITEM')
      return new Promise((complete) => {
        route.commands.push({ kind: 'grant', grantId, grant: normalized, complete })
      })
    },
    progression(room: MapRuntime, connection: object, afterVersion = -1): OwnerProgression | undefined {
      const route = connections.get(connection)
      const binding = route?.room === room ? room.binding(connection) : undefined
      const character = route && characters.read(route.characterId)
      if (route && binding && character && character.version > afterVersion) return progressionSnapshot(route, binding)
    },
    inventory(room: MapRuntime, connection: object, afterVersion = -1): OwnerInventory | undefined {
      const route = connections.get(connection)
      const binding = route?.room === room ? room.binding(connection) : undefined
      const character = route && characters.read(route.characterId)
      if (route && binding && character && character.version > afterVersion) return inventorySnapshot(route, binding)
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
