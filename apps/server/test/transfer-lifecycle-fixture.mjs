import { matchMaker, RoomInternalState, Server } from '@colyseus/core'
import { Client } from '@colyseus/sdk'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { MapRoomSchema } from '@viesma/network-colyseus'
import {
  cancelTransferMessage,
  interactPortalMessage,
  mapRoomJoinedMessage,
  mapRoomName,
  movementCheckpointMessage,
  ownerGroundLootMessage,
  ownerInventoryMessage,
  ownerProgressionMessage,
  PROTOCOL_VERSION,
  transferFailureMessage,
  transferOfferMessage,
  villageMapRoomName,
} from '@viesma/protocol'
import { placePlayerAtSpawn } from '@viesma/simulation'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { observeSeats } from './capacity-audit.mjs'

export async function until(read, label) {
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    const value = await read()
    if (value) return value
    await delay(5)
  }
  throw new Error(label)
}

export async function startTransferFixture(createWorldCoordinator, createMapRoomClass, createDestinationRoom) {
  const data = loadGrayboxGameData()
  const version = {
    protocolVersion: PROTOCOL_VERSION,
    balanceVersion: data.balanceVersion,
    mapContentHash: createHash('sha256').update(serializeMapManifest(data)).digest('hex'),
  }
  let now = 0
  let wake
  let queued = 0
  let cancellations = 0
  let tickNumber = 0
  const rooms = new Map()
  const events = []
  const incidents = []
  const transportRoom = (roomId) => matchMaker.getLocalRoomById(roomId)
  const world = createWorldCoordinator(data, version.mapContentHash, {
    clock: { nowMilliseconds: () => now },
    nextId: randomUUID,
    createDestination: createDestinationRoom,
    schedule(callback) {
      wake = callback
      return () => (wake = undefined)
    },
    onBacklog() {},
  })

  function status(roomId, room = transportRoom(roomId)) {
    const entry = rooms.get(roomId)
    return {
      active: entry?.connections.size ?? 0,
      grace: entry?.disconnected.size ?? 0,
      incoming: entry?.incoming.size ?? 0,
      clients: room?.clients.length ?? 0,
      transportReservations: room ? Object.keys(room._reservedSeats).length : 0,
      autoDispose: room?.autoDispose,
      locked: room?.locked,
      transportState: room ? Object.keys(RoomInternalState).find((id) => RoomInternalState[id] === room._internalState) : 'UNREGISTERED',
      registered: !!transportRoom(roomId),
    }
  }

  function record(kind, runtime, room) {
    events.push({ kind, tick: tickNumber, roomId: runtime.roomId, ...status(runtime.roomId, room) })
  }

  const observedWorld = {
    ...world,
    createRoom(...args) {
      const runtime = world.createRoom(...args)
      const entry = { runtime, connections: new Map(), disconnected: new Set(), incoming: new Set() }
      rooms.set(runtime.roomId, entry)
      observeSeats(runtime, entry, (issue) => incidents.push(issue))
      const reserve = runtime.reserve
      runtime.reserve = (characterId) => {
        const result = reserve(characterId)
        if (result) record('reserve', runtime)
        return result
      }
      return runtime
    },
    requestPortal(...args) {
      const result = world.requestPortal(...args)
      if (result) queued++
      return result
    },
    cancelTransfer(...args) {
      world.cancelTransfer(...args)
      cancellations++
    },
    acceptTransfer(runtime, ...args) {
      const result = world.acceptTransfer(runtime, ...args)
      if (result) record('claim', runtime)
      return result
    },
  }
  const transport = new WebSocketTransport({ maxPayload: 4096 })
  const server = new Server({ transport, gracefullyShutdown: false, greet: false })
  function define(name, mapId) {
    const ProductionRoom = createMapRoomClass(observedWorld, version, 15, mapId)
    server.define(
      name,
      class extends ProductionRoom {
        onLeave(socket) {
          super.onLeave(socket)
          record('leave', rooms.get(this.roomId).runtime, this)
        }
        onDispose() {
          const entry = rooms.get(this.roomId)
          record('dispose', entry.runtime, this)
          if (entry.runtime.hasRetainedSeats()) incidents.push('Disposed with retained application seats')
          super.onDispose()
          rooms.delete(this.roomId)
        }
      }
    )
  }
  define(mapRoomName, 'm1')
  define(villageMapRoomName, 'village')
  await server.listen(0, '127.0.0.1')
  const client = new Client(`http://127.0.0.1:${transport.server.address().port}`)

  function observe(room) {
    const link = { room, requestId: 0 }
    room.reconnection.enabled = false
    room.onMessage(mapRoomJoinedMessage, (binding) => (link.binding = binding))
    room.onMessage(transferOfferMessage, (offer) => (link.offer = offer))
    room.onMessage(transferFailureMessage, (failure) => (link.failure = failure))
    room.onLeave(() => (link.closed = true))
    for (const type of [movementCheckpointMessage, ownerGroundLootMessage, ownerProgressionMessage, ownerInventoryMessage]) {
      room.onMessage(type, () => {})
    }
    return link
  }

  function tick(elapsed = 1000 / 30 + 0.0001) {
    now += elapsed
    tickNumber++
    wake()
  }

  const runtime = (roomId) => rooms.get(roomId)?.runtime
  const socket = (link) => transportRoom(link.room.roomId)?.clients.getById(link.room.sessionId)
  const binding = (link) => until(() => link.binding, 'Missing authoritative MapRoomJoined')
  const joinById = (roomId, options = {}) => client.joinById(roomId, { ...version, ...options }, MapRoomSchema)

  async function fresh(roomId) {
    const link = observe(await (roomId ? joinById(roomId) : client.create(mapRoomName, version, MapRoomSchema)))
    await binding(link)
    return link
  }

  async function portal(link, portalId) {
    const source = runtime(link.room.roomId)
    const body = source.player(link.binding.characterId)
    const portal = source.map.portals.find(({ id }) => id === portalId)
    source.respawn(socket(link), placePlayerAtSpawn(body, { x: portal.bounds.origin.x + 20, y: body.position.y }, 'right'))
    const before = queued
    link.offer = undefined
    link.failure = undefined
    link.room.send(interactPortalMessage, { requestId: ++link.requestId, mapEpoch: link.binding.mapEpoch, objectId: portalId })
    await until(() => queued === before + 1, 'Portal request was not queued')
  }

  async function cancel(link, ticket = link.offer.ticket) {
    const before = cancellations
    link.room.send(cancelTransferMessage, { ticket })
    await until(() => cancellations === before + 1, 'Cancellation did not reach the server')
  }

  const candidate = async (source, offer = source.offer) =>
    observe(await joinById(offer.roomId, { ticket: offer.ticket, reconnectToken: source.binding.reconnectToken }))

  async function startPortal(link, portalId) {
    await portal(link, portalId)
    tick()
    return until(() => link.offer, 'Missing TransferOffer')
  }

  async function empty(roomId) {
    await until(() => !transportRoom(roomId) && !rooms.has(roomId), `Transport room ${roomId} was not disposed`)
  }

  async function cleanRooms() {
    for (const roomId of rooms.keys()) await transportRoom(roomId)?.disconnect()
  }

  return {
    world,
    rooms,
    events,
    incidents,
    transportRoom,
    status,
    running: () => !!wake,
    tick,
    fresh,
    portal,
    startPortal,
    cancel,
    candidate,
    joinById,
    async reconnect(source) {
      const link = observe(await joinById(source.room.roomId, { reconnectToken: source.binding.reconnectToken }))
      await binding(link)
      return link
    },
    createVillage: createDestinationRoom.bind(undefined, 'village'),
    runtime,
    socket,
    binding,
    empty,
    cleanRooms,
    close: () => server.gracefullyShutdown(false),
  }
}

export async function enterLastDepartureWindow(h) {
  const first = await h.fresh()
  const second = await h.fresh(first.room.roomId)
  const { roomId } = await h.createVillage()
  h.tick()
  await h.startPortal(first, 'p_to_village')
  const village = await h.candidate(first)
  h.tick()
  await h.binding(village)
  assert.equal(village.room.roomId, roomId)
  const colyseusVillage = h.transportRoom(roomId)
  await until(() => colyseusVillage.autoDispose && !colyseusVillage._autoDisposeTimeout, 'Village cannot yet auto-dispose')

  await h.startPortal(village, 'p_to_m1')
  const returning = await h.candidate(village)
  await h.portal(second, 'p_to_village')
  // 此 tick 依角色順序先提交甲回 M1，再替乙預留同一間 Village。
  h.tick()
  await h.binding(returning)
  await until(() => second.offer, 'Missing second TransferOffer')
  assert.equal(second.offer.roomId, roomId)
  return { first, second, village, returning, roomId }
}
