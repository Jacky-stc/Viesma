import { loadGrayboxGameData } from '@viesma/game-data'
import { PROTOCOL_VERSION } from '@viesma/protocol'
import { findOverlappingPortal } from '@viesma/simulation'
import { expect, test, vi } from 'vitest'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'

function harness(createDestination) {
  let now = 0
  let id = 0
  let wake
  const world = createWorldCoordinator(loadGrayboxGameData(), 'hash', {
    clock: { nowMilliseconds: () => now },
    nextId: () => `id-${++id}`,
    schedule(callback) {
      wake = callback
      return () => {
        wake = undefined
      }
    },
    onBacklog: vi.fn(),
    createDestination,
  })
  return {
    world,
    advance(milliseconds = 34) {
      now += milliseconds
      wake?.()
    },
    setNow(milliseconds) {
      now += milliseconds
    },
  }
}

function peer() {
  return { connection: {}, joined: vi.fn(), offer: vi.fn(), failed: vi.fn(), close: vi.fn() }
}

const session = (peer) => peer.joined.mock.lastCall[0]
const offer = (peer) => peer.offer.mock.lastCall[0]
const body = (room, peer) => room.player(session(peer).characterId)

function walkToPortal({ world, advance }, room, ...peers) {
  advance()
  for (let seq = 1; seq <= 30; seq++) {
    if (peers.every((peer) => findOverlappingPortal(room.map, body(room, peer).position))) return
    for (const peer of peers) {
      const { connectionEpoch, mapEpoch } = session(peer)
      expect(
        world.receive(room, peer.connection, {
          protocolVersion: PROTOCOL_VERSION,
          connectionEpoch,
          mapEpoch,
          seq,
          moveX: -1,
          jumpPressed: false,
          attackPressed: false,
        })
      ).toBe(true)
    }
    advance()
  }
  throw new Error('The fixture did not reach the portal')
}

function request(world, room, peer, requestId = 1, overrides = {}) {
  return world.requestPortal(room, peer.connection, {
    requestId,
    mapEpoch: session(peer).mapEpoch,
    objectId: room.map.id === 'm1' ? 'p_to_village' : 'p_to_m1',
    ...overrides,
  })
}

function claim(world, room, source, candidate, token = session(source).reconnectToken) {
  return world.acceptTransfer(room, candidate, offer(source).ticket, token)
}

test('routes a stable actor through Village and M1 before either room steps, with a single private owner', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  const observer = peer()
  expect(world.join(m1, source)).toBe(true)
  expect(world.join(m1, observer)).toBe(true)
  expect(world.join(village, source)).toBe(false)
  const { characterId, connectionEpoch, reconnectToken } = session(source)
  expect(request(world, m1, source, 0)).toBe(true)
  advance()
  expect(source.failed).toHaveBeenLastCalledWith({ requestId: 0, code: 'PORTAL_UNAVAILABLE' })

  walkToPortal(h, m1, source)
  expect(request(world, m1, source)).toBe(true)
  expect(request(world, m1, source)).toBe(false)
  advance()
  expect(offer(source)).toMatchObject({ requestId: 1, mapId: 'village', mapEpoch: 1 })
  expect(body(m1, source)).toBeDefined()
  expect(village.player(characterId)).toBeUndefined()
  const next = peer()
  expect(claim(world, m1, source, next)).toBe(false)
  expect(claim(world, village, source, next, session(observer).reconnectToken)).toBe(false)
  expect(claim(world, village, source, next)).toBe(true)
  expect(claim(world, village, source, peer())).toBe(false)
  expect(next.joined).not.toHaveBeenCalled()
  expect(world.checkpoint(village, next.connection)).toBeUndefined()

  const vitals = { hp: 19, maxHp: 50, mp: 4, maxMp: 20 }
  const before = body(m1, source)
  const readPlayer = m1.player
  const player = vi.spyOn(m1, 'player').mockImplementation((id) => (id === characterId ? { ...before, vitals } : readPlayer(id)))
  const advanceM1 = m1.advance
  const advanceVillage = village.advance
  vi.spyOn(m1, 'advance').mockImplementation((...args) => {
    expect(m1.snapshot().players.some((player) => player.characterId === characterId)).toBe(false)
    expect(village.player(characterId)).toBeDefined()
    advanceM1(...args)
  })
  vi.spyOn(village, 'advance').mockImplementation((...args) => {
    expect(m1.snapshot().players.some((player) => player.characterId === characterId)).toBe(false)
    expect(village.player(characterId)).toBeDefined()
    advanceVillage(...args)
  })
  advance()
  player.mockRestore()
  m1.advance.mockRestore()
  village.advance.mockRestore()
  expect(m1.player(characterId)).toBeUndefined()
  expect(body(village, next)).toMatchObject({ vitals, lifeStartedTick: before.lifeStartedTick, position: { x: 1188, y: 656 } })
  expect(m1.snapshot().monsters).toHaveLength(1)
  expect(village.snapshot().monsters).toHaveLength(0)
  expect(session(next)).toMatchObject({ characterId, reconnectToken, mapEpoch: 1 })
  expect(session(next).connectionEpoch).not.toBe(connectionEpoch)
  expect(world.checkpoint(m1, source.connection)).toBeUndefined()
  expect(world.checkpoint(village, next.connection)).toMatchObject({ characterId, mapEpoch: 1, ackInputSeq: null })
  expect(world.checkpoint(m1, observer.connection).characterId).toBe(session(observer).characterId)
  expect(JSON.stringify(village.snapshot())).not.toContain(reconnectToken)
  expect(claim(world, village, source, peer())).toBe(false)
  world.leave(m1, source.connection)
  expect(request(world, village, next, 1, { mapEpoch: 0 })).toBe(false)
  expect(
    world.receive(village, next.connection, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch: session(next).connectionEpoch,
      mapEpoch: 0,
      seq: 1,
      moveX: -1,
      jumpPressed: false,
      attackPressed: false,
    })
  ).toBe(false)

  walkToPortal(h, village, next)
  expect(request(world, village, next)).toBe(true)
  advance()
  const returned = peer()
  expect(claim(world, m1, next, returned)).toBe(true)
  for (const [room, step] of [
    [m1, advanceM1],
    [village, advanceVillage],
  ]) {
    vi.spyOn(room, 'advance').mockImplementation((...args) => {
      expect(m1.player(characterId)).toBeDefined()
      expect(village.player(characterId)).toBeUndefined()
      step(...args)
    })
  }
  advance()
  expect(session(returned)).toMatchObject({ characterId, mapEpoch: 2 })
  expect(body(m1, returned)).toMatchObject({ vitals, position: { x: 308, y: 848 }, spawnProtected: true })
  expect(village.player(characterId)).toBeUndefined()
  expect(request(world, m1, returned, 1)).toBe(true)
  advance()
  expect(returned.offer).not.toHaveBeenCalled()
})

test('rejects invalid requests, enforces 20 seats under competition and rolls back an expired offer', () => {
  const h = harness()
  const { world, advance, setNow } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const first = peer()
  const second = peer()
  world.join(m1, first)
  world.join(m1, second)
  const residents = Array.from({ length: 19 }, peer)
  for (const resident of residents) expect(world.join(village, resident)).toBe(true)
  walkToPortal(h, m1, first, second)
  expect(request(world, m1, first, 0, { destination: 'village' })).toBe(false)
  expect(request(world, m1, first, 0, { mapEpoch: 99 })).toBe(false)
  expect(request(world, m1, first, 0, { objectId: 'p_to_m5' })).toBe(true)
  advance()
  expect(first.failed).toHaveBeenCalledWith({ requestId: 0, code: 'PORTAL_UNAVAILABLE' })
  expect(request(world, m1, first, 0)).toBe(false)
  expect(request(world, m1, first)).toBe(true)
  expect(request(world, m1, second)).toBe(true)
  advance()
  const frozen = body(m1, first).position
  expect(first.offer).toHaveBeenCalledOnce()
  expect(second.failed).toHaveBeenLastCalledWith({ requestId: 1, code: 'MAP_SEAT_UNAVAILABLE' })
  expect(village.snapshot().players).toHaveLength(19)
  expect(world.join(village, peer())).toBe(false)
  setNow(10_000)
  expect(claim(world, village, first, peer())).toBe(false)
  advance()
  expect(first.failed).toHaveBeenLastCalledWith({ requestId: 1, code: 'TRANSFER_EXPIRED' })
  expect(body(m1, first).position).toEqual(frozen)
  expect(village.hasCapacity()).toBe(true)
  expect(world.canAdmit()).toBe(false)
  expect(world.join(village, peer())).toBe(false)
  expect(world.checkpoint(m1, first.connection).mapEpoch).toBe(0)
})

test('rejects an overlapping Up request while airborne', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  world.createRoom('village')
  const source = peer()
  world.join(m1, source)
  walkToPortal(h, m1, source)
  const { connectionEpoch, mapEpoch } = session(source)
  expect(
    world.receive(m1, source.connection, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      seq: 45,
      moveX: 0,
      jumpPressed: true,
      attackPressed: false,
    })
  ).toBe(true)
  advance()
  expect(body(m1, source).physics.grounded).toBe(false)
  expect(findOverlappingPortal(m1.map, body(m1, source).position)?.id).toBe('p_to_village')
  expect(request(world, m1, source)).toBe(true)
  advance()
  expect(source.failed).toHaveBeenCalledExactlyOnceWith({ requestId: 1, code: 'PORTAL_UNAVAILABLE' })
  expect(source.offer).not.toHaveBeenCalled()
})

test('restores the source after destination creation fails or a claimed destination is lost before the commit', async () => {
  const createDestination = vi.fn().mockRejectedValue(new Error('no room'))
  const h = harness(createDestination)
  const { world, advance } = h
  const m1 = world.createRoom()
  const source = peer()
  world.join(m1, source)
  walkToPortal(h, m1, source)
  expect(request(world, m1, source)).toBe(true)
  advance()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  advance()
  expect(createDestination).toHaveBeenCalledExactlyOnceWith('village')
  expect(source.failed).toHaveBeenLastCalledWith({ requestId: 1, code: 'TRANSFER_FAILED' })
  expect(body(m1, source)).toBeDefined()

  const village = world.createRoom('village')
  expect(request(world, m1, source, 2)).toBe(true)
  advance()
  const candidate = peer()
  expect(claim(world, village, source, candidate)).toBe(true)
  const prepareArrival = vi.spyOn(village, 'prepareArrival').mockImplementationOnce(() => {
    throw new Error('arrival preparation failed')
  })
  expect(advance).not.toThrow()
  prepareArrival.mockRestore()
  expect(candidate.joined).not.toHaveBeenCalled()
  expect(candidate.close).toHaveBeenCalledOnce()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(village.player(session(source).characterId)).toBeUndefined()
  expect(source.failed).toHaveBeenLastCalledWith({ requestId: 2, code: 'TRANSFER_FAILED' })
  expect(body(m1, source)).toBeDefined()
  expect(m1.snapshot().serverTick).toBe(village.snapshot().serverTick)
  expect(world.reconnect(m1, peer(), session(source).reconnectToken)).toBe(false)
  expect(claim(world, village, source, peer())).toBe(false)
  world.leave(village, candidate.connection)
  expect(world.checkpoint(m1, source.connection)).toBeDefined()
})

test('keeps the committed body recoverable when transport callbacks throw', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  expect(world.join(m1, source)).toBe(true)
  walkToPortal(h, m1, source)
  const { characterId, reconnectToken } = session(source)
  expect(request(world, m1, source)).toBe(true)
  advance()
  const candidate = peer()
  expect(claim(world, village, source, candidate)).toBe(true)
  candidate.joined.mockImplementationOnce(() => {
    throw new Error('destination notification failed')
  })
  source.close.mockImplementationOnce(() => {
    throw new Error('source close failed')
  })
  expect(advance).not.toThrow()
  expect(candidate.close).toHaveBeenCalledOnce()
  expect(source.close).toHaveBeenCalledOnce()
  expect(m1.player(characterId)).toBeUndefined()
  expect(village.player(characterId)).toBeDefined()
  expect(m1.snapshot().serverTick).toBe(village.snapshot().serverTick)
  expect(village.hasRetainedSeats()).toBe(true)
  expect(world.checkpoint(village, candidate.connection)).toBeUndefined()
  expect(world.checkpoint(m1, source.connection)).toBeUndefined()
  expect(claim(world, village, source, peer())).toBe(false)
  expect(world.reconnect(m1, peer(), reconnectToken)).toBe(false)

  const recovered = peer()
  expect(world.reconnect(village, recovered, reconnectToken)).toBe(true)
  expect(session(recovered)).toMatchObject({ characterId, mapEpoch: 1 })
  expect(session(recovered).reconnectToken).not.toBe(reconnectToken)
  world.leave(m1, source.connection)
  world.leave(village, candidate.connection)
  expect(world.checkpoint(village, recovered.connection)).toMatchObject({ characterId, mapEpoch: 1 })
})

test('disposal clears destination claims and removes source grace seats and credentials', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  expect(world.join(m1, source)).toBe(true)
  walkToPortal(h, m1, source)
  expect(request(world, m1, source)).toBe(true)
  advance()
  const candidate = peer()
  expect(claim(world, village, source, candidate)).toBe(true)
  world.disposeRoom(village)
  advance()
  expect(candidate.close).toHaveBeenCalledOnce()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(source.failed).toHaveBeenLastCalledWith({ requestId: 1, code: 'TRANSFER_FAILED' })
  expect(world.checkpoint(m1, source.connection)).toBeDefined()
  const { characterId, reconnectToken } = session(source)
  world.leave(m1, source.connection, true)
  world.disposeRoom(m1)
  expect(m1.hasRetainedSeats()).toBe(false)
  expect(m1.player(characterId)).toBeUndefined()
  const replacement = world.createRoom()
  expect(world.reconnect(m1, peer(), reconnectToken)).toBe(false)
  expect(world.reconnect(replacement, peer(), reconnectToken)).toBe(false)
  expect(claim(world, world.createRoom('village'), source, candidate)).toBe(false)
  expect(world.join(replacement, candidate)).toBe(true)
})

test('recovers pre-commit at the source and post-commit at the destination while fencing input and old callbacks', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const original = peer()
  world.join(m1, original)
  walkToPortal(h, m1, original)
  const { characterId, reconnectToken, connectionEpoch } = session(original)
  const frame = (epoch, mapEpoch, seq = 45) => ({
    protocolVersion: PROTOCOL_VERSION,
    connectionEpoch: epoch,
    mapEpoch,
    seq,
    moveX: 1,
    jumpPressed: true,
    attackPressed: false,
  })
  expect(world.receive(m1, original.connection, frame(connectionEpoch, 0))).toBe(true)
  expect(request(world, m1, original)).toBe(true)
  advance()
  const uncommitted = peer()
  expect(claim(world, village, original, uncommitted)).toBe(true)
  world.leave(m1, original.connection, true)
  expect(uncommitted.close).toHaveBeenCalledOnce()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(m1.hasRetainedSeats()).toBe(true)
  expect(world.checkpoint(m1, original.connection)).toBeUndefined()
  expect(world.receive(m1, original.connection, frame(connectionEpoch, 0))).toBe(false)
  expect(world.reconnect(village, peer(), reconnectToken)).toBe(false)
  expect(world.reconnect(m1, peer(), 'wrong')).toBe(false)
  advance()
  expect(m1.player(characterId)).toMatchObject({ physics: { grounded: true }, movement: { moveX: 0, jumpBufferTicksRemaining: 0 } })

  const recovered = peer()
  expect(world.reconnect(m1, recovered, reconnectToken)).toBe(true)
  expect(world.reconnect(m1, peer(), reconnectToken)).toBe(false)
  expect(session(recovered)).toMatchObject({ characterId, mapEpoch: 0 })
  expect(session(recovered).connectionEpoch).not.toBe(connectionEpoch)
  expect(session(recovered).reconnectToken).not.toBe(reconnectToken)
  expect(world.receive(m1, recovered.connection, frame(connectionEpoch, 0))).toBe(false)
  world.leave(m1, original.connection)
  world.leave(m1, original.connection, true)
  world.leave(village, uncommitted.connection, true)
  expect(world.checkpoint(m1, recovered.connection)).toMatchObject({ ackInputSeq: null })

  expect(request(world, m1, recovered)).toBe(true)
  advance()
  const destination = peer()
  expect(claim(world, village, recovered, destination)).toBe(true)
  advance()
  world.leave(village, destination.connection, true)
  world.leave(m1, recovered.connection)
  expect(world.reconnect(m1, peer(), session(recovered).reconnectToken)).toBe(false)
  expect(world.reconnect(village, peer(), reconnectToken)).toBe(false)
  const landed = peer()
  expect(world.reconnect(village, landed, session(recovered).reconnectToken)).toBe(true)
  expect(session(landed)).toMatchObject({ characterId, mapEpoch: 1 })
  expect(body(village, landed).position).toEqual({ x: 1188, y: 656 })
  expect(m1.player(characterId)).toBeUndefined()
  expect(world.receive(village, landed.connection, frame(session(destination).connectionEpoch, 1, 1))).toBe(false)
  expect(world.receive(village, landed.connection, frame(session(landed).connectionEpoch, 1, 1))).toBe(true)
  world.leave(village, destination.connection, true)
  expect(world.checkpoint(village, landed.connection)).toMatchObject({ characterId, mapEpoch: 1 })
})

test('expires grace seats at 30 seconds and keeps an unconfirmed token only for lost join acknowledgement recovery', () => {
  const h = harness()
  const { world, advance, setNow } = h
  const room = world.createRoom()
  const original = peer()
  world.join(room, original)
  for (let index = 0; index < 19; index++) expect(world.join(room, peer())).toBe(true)
  advance()
  const { characterId, connectionEpoch, reconnectToken, mapEpoch } = session(original)
  const atSpawn = room.player(characterId).position
  expect(
    world.receive(room, original.connection, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      seq: 1,
      moveX: 1,
      jumpPressed: true,
      attackPressed: false,
    })
  ).toBe(true)
  world.leave(room, original.connection, true)
  advance()
  expect(room.player(characterId)).toMatchObject({
    position: atSpawn,
    physics: { grounded: true },
    movement: { moveX: 0, lastProcessedInputSeq: null },
  })
  expect(world.join(room, peer())).toBe(false)
  const intermediate = peer()
  setNow(29_999 - 34)
  expect(world.reconnect(room, intermediate, reconnectToken)).toBe(true)
  world.leave(room, intermediate.connection, true)
  const restored = peer()
  expect(world.reconnect(room, restored, reconnectToken)).toBe(true)
  expect(body(room, restored).position).toEqual(atSpawn)
  expect(world.reconnect(room, peer(), session(intermediate).reconnectToken)).toBe(false)
  world.leave(room, restored.connection, true)
  setNow(30_000)
  expect(world.reconnect(room, peer(), session(restored).reconnectToken)).toBe(false)
  expect(world.reconnect(room, peer(), reconnectToken)).toBe(false)
  advance()
  expect(room.player(characterId)).toBeUndefined()
  expect(room.hasCapacity()).toBe(true)
  expect(room.hasRetainedSeats()).toBe(false)
})

test('cancels a claimed ticket on destination drop and ignores later cancellation or timeout callbacks', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  world.join(m1, source)
  walkToPortal(h, m1, source)
  request(world, m1, source)
  advance()
  const candidate = peer()
  expect(claim(world, village, source, candidate)).toBe(true)
  world.cancelTransfer(m1, candidate.connection, offer(source).ticket)
  world.cancelTransfer(m1, source.connection, 'wrong')
  world.leave(village, candidate.connection, true)
  world.leave(village, candidate.connection)
  advance()
  expect(source.failed).toHaveBeenCalledExactlyOnceWith({ requestId: 1, code: 'TRANSFER_FAILED' })
  expect(candidate.joined).not.toHaveBeenCalled()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(body(m1, source)).toBeDefined()
  const stale = offer(source).ticket
  request(world, m1, source, 2)
  advance()
  world.cancelTransfer(m1, source.connection, stale)
  expect(claim(world, village, source, peer())).toBe(true)
  advance()
  expect(village.player(session(source).characterId)).toBeDefined()
})

test('retains a disconnected Death body until the recovered owner can take the Village respawn handoff', () => {
  const { world, advance } = harness()
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  world.join(m1, source)
  const { characterId, connectionEpoch, mapEpoch, reconnectToken } = session(source)
  advance()
  for (let seq = 1; seq <= 180 && body(m1, source).action.kind !== 'death'; seq++) {
    world.receive(m1, source.connection, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      seq,
      moveX: 1,
      jumpPressed: false,
      attackPressed: false,
    })
    advance()
  }
  const dead = body(m1, source)
  expect(dead.action.kind).toBe('death')
  world.leave(m1, source.connection, true)
  for (let tick = 0; tick < 95; tick++) advance()
  expect(m1.player(characterId)).toMatchObject({ action: dead.action, position: dead.position })
  expect(village.player(characterId)).toBeUndefined()
  expect(village.hasRetainedSeats()).toBe(false)
  const rebound = peer()
  expect(world.reconnect(m1, rebound, reconnectToken)).toBe(true)
  advance()
  expect(offer(rebound)).toMatchObject({ requestId: null, mapId: 'village', mapEpoch: 1 })
  const destination = peer()
  expect(claim(world, village, rebound, destination)).toBe(true)
  advance()
  expect(session(destination)).toMatchObject({ characterId, mapEpoch: 1 })
  expect(m1.player(characterId)).toBeUndefined()
  const respawned = body(village, destination)
  expect(respawned).toMatchObject({ action: { kind: 'none' }, position: { x: 628, y: 656 } })
  expect(respawned.vitals.hp).toBe(respawned.vitals.maxHp)
  expect(respawned.lifeStartedTick).toBeGreaterThan(dead.lifeStartedTick)
})
