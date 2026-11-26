import { PROTOCOL_VERSION } from '@viesma/protocol'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createDestinationRoom, createMapRoomClass } from '../src/adapters/map-room.ts'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'
import { enterLastDepartureWindow, startTransferFixture, until } from './transfer-lifecycle-fixture.mjs'

let h
beforeAll(async () => {
  h = await startTransferFixture(createWorldCoordinator, createMapRoomClass, createDestinationRoom)
})
afterEach(async () => {
  await h.cleanRooms()
  expect(h.incidents.splice(0)).toEqual([])
  h.events.length = 0
}, 10_000)
afterAll(async () => {
  await h?.close()
})

async function setupSource() {
  const source = await h.fresh()
  const { roomId } = await h.createVillage()
  h.tick()
  const offer = await h.startPortal(source, 'p_to_village')
  expect(offer.roomId).toBe(roomId)
  expect(h.status(roomId)).toMatchObject({ active: 0, grace: 0, incoming: 1, clients: 0, transportReservations: 0, autoDispose: false })
  return { source, roomId, offer }
}

function expectAuthority(link, id = link.binding.characterId) {
  const room = h.runtime(link.room.roomId)
  expect([...h.rooms.values()].filter(({ runtime }) => runtime.player(id))).toEqual([expect.objectContaining({ runtime: room })])
  expect(h.world.checkpoint(room, h.socket(link))).toMatchObject({ characterId: id, connectionEpoch: link.binding.connectionEpoch })
}

function expectInputResumed(link) {
  const { connectionEpoch, mapEpoch } = link.binding
  expect(
    h.world.receive(h.runtime(link.room.roomId), h.socket(link), {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      seq: 1,
      moveX: 0,
      jumpPressed: false,
      attackPressed: false,
    })
  ).toBe(true)
}

async function expectReleased(roomId) {
  expect(h.status(roomId)).toMatchObject({ active: 0, grace: 0, incoming: 0, autoDispose: true })
  await h.empty(roomId)
  expect(h.events.at(-1)).toMatchObject({ kind: 'dispose', roomId, active: 0, grace: 0, incoming: 0, clients: 0, transportReservations: 0 })
}

test('retains the real Village transport room when its last client leaves before a new incoming reservation in the same tick', async () => {
  const { second, returning, roomId } = await enterLastDepartureWindow(h)
  const events = h.events.filter((event) => event.roomId === roomId)
  expect(events.slice(-2)).toMatchObject([
    { kind: 'leave', active: 0, incoming: 0, clients: 0, autoDispose: true, locked: false },
    {
      kind: 'reserve',
      active: 0,
      incoming: 1,
      clients: 0,
      transportReservations: 0,
      autoDispose: false,
      locked: false,
      transportState: 'CREATED',
    },
  ])
  expect(events.at(-2).tick).toBe(events.at(-1).tick)
  expectAuthority(second)
  expectAuthority(returning)
  const previousSocket = h.socket(second)
  const previousRoom = h.runtime(second.room.roomId)
  const candidate = await h.candidate(second)
  expect(candidate.binding).toBeUndefined()
  expect(h.status(roomId)).toMatchObject({ active: 0, incoming: 1, clients: 1, transportReservations: 0, autoDispose: false })
  expectAuthority(second)
  h.tick()
  await h.binding(candidate)
  expect(candidate.binding.mapEpoch).toBe(second.binding.mapEpoch + 1)
  expect(h.status(roomId)).toMatchObject({ active: 1, incoming: 0, clients: 1, autoDispose: true })
  expectAuthority(candidate, second.binding.characterId)
  expect(h.world.checkpoint(previousRoom, previousSocket)).toBeUndefined()
  expect(h.world.inventory(previousRoom, previousSocket)).toBeUndefined()
  expect(h.world.ownerGroundLoot(previousRoom, previousSocket)).toBeUndefined()
  await candidate.room.leave()
  await h.empty(roomId)
})

test.each([
  ['cancel before join', 'TRANSFER_FAILED'],
  ['offer expiry', 'TRANSFER_EXPIRED'],
  ['claimed ticket expiry', 'TRANSFER_EXPIRED'],
  ['commit preparation failure', 'TRANSFER_FAILED'],
  ['candidate drop', 'TRANSFER_FAILED'],
])('releases the application seat and disposes the empty transport after %s', async (cause, code) => {
  const { source, roomId, offer } = await setupSource()
  const candidate = ['claimed ticket expiry', 'commit preparation failure', 'candidate drop'].includes(cause)
    ? await h.candidate(source)
    : undefined
  if (cause === 'cancel before join') await h.cancel(source)
  if (cause === 'commit preparation failure') vi.spyOn(h.runtime(roomId), 'prepareArrival').mockReturnValueOnce(undefined)
  if (cause === 'candidate drop') {
    await candidate.room.leave(false)
    await until(() => h.status(roomId).clients === 0, 'Candidate transport did not leave')
  }
  expectAuthority(source)
  const expired = cause.endsWith('expiry')
  h.tick(expired ? 10_000 : undefined)
  await until(() => source.failure, 'No failure sent to source')
  expect(source.failure).toMatchObject({ requestId: offer.requestId, code })
  if (expired) {
    while (h.world.tickDiagnostics().backlogTicks) h.tick(0)
  }
  expectAuthority(source)
  expectInputResumed(source)
  if (candidate) {
    await until(() => candidate.closed, 'Candidate socket did not close')
    expect(candidate.binding).toBeUndefined()
  }
  await expectReleased(roomId)
  await expect(h.candidate(source)).rejects.toMatchObject({ code: 522, message: expect.stringContaining('not found') })
})

test('source transport drop cancels its pending handoff and allows a grace reconnect only at the source', async () => {
  const { source, roomId } = await setupSource()
  const candidate = await h.candidate(source)
  const id = source.room.roomId
  await source.room.leave(false)
  await until(() => h.status(id).grace === 1, 'Missing grace seat')
  expect(h.status(id)).toMatchObject({ active: 0, grace: 1, clients: 0, autoDispose: false })
  await until(() => candidate.closed, 'Candidate socket did not close after source drop')
  expect(candidate.binding).toBeUndefined()
  const reconnected = await h.reconnect(source)
  expect(reconnected.binding.connectionEpoch).not.toBe(source.binding.connectionEpoch)
  expect(h.status(id)).toMatchObject({ active: 1, grace: 0, clients: 1, autoDispose: true })
  expectAuthority(reconnected, source.binding.characterId)
  await expectReleased(roomId)
})

test('never offers a disposing transport and creates a valid new instance after it is unregistered', async () => {
  const { source: first, roomId } = await setupSource()
  const second = await h.fresh(first.room.roomId)
  const village = await h.candidate(first)
  h.tick()
  await h.binding(village)
  await h.portal(second, 'p_to_village')

  const disposal = h.transportRoom(roomId).disconnect()
  expect(h.status(roomId)).toMatchObject({ transportState: 'DISPOSING', registered: true, clients: 0 })
  h.tick()
  await disposal
  await h.empty(roomId)
  await until(() => second.failure, 'Disposing destination did not fail')
  expect(second.offer).toBeUndefined()
  expect(second.failure.code).toBe('MAP_SEAT_UNAVAILABLE')
  expectAuthority(second)

  await h.portal(second, 'p_to_village')
  h.tick()
  const entry = await until(() => [...h.rooms.values()].find(({ runtime }) => runtime.map.id === 'village'), 'No replacement Village')
  await until(() => h.transportRoom(entry.runtime.roomId), 'Replacement Village was not registered')
  h.tick()
  const offer = await until(() => second.offer, 'Replacement Village offer was not sent')
  expect(offer.roomId).not.toBe(roomId)
  const candidate = await h.candidate(second)
  h.tick()
  await h.binding(candidate)
  expectAuthority(candidate, second.binding.characterId)
  await candidate.room.leave()
  await h.empty(offer.roomId)
  await h.empty(second.room.roomId)
  expect(h.running()).toBe(false)
})

test('keeps multiple incoming reservations live and fences old tickets and candidate callbacks', async () => {
  const { source: first, roomId, offer: old } = await setupSource()
  const second = await h.fresh(first.room.roomId)
  h.tick()
  await h.startPortal(second, 'p_to_village')
  expect(h.status(roomId)).toMatchObject({ incoming: 2, clients: 0, transportReservations: 0, autoDispose: false })
  const staleCandidate = await h.candidate(first)
  const staleSocket = h.socket(staleCandidate)
  await h.cancel(first)
  h.tick()
  await until(() => first.failure && staleCandidate.closed, 'Canceled handoff did not close')
  expect(h.status(roomId)).toMatchObject({ incoming: 1, clients: 0, autoDispose: false })

  await h.startPortal(first, 'p_to_village')
  await expect(h.candidate(first, old)).rejects.toThrow('MAP_ADMISSION_INVALID')
  await h.cancel(first, old.ticket)
  h.world.leave(h.runtime(roomId), staleSocket, true)
  const current = await h.candidate(first)
  expect(h.status(roomId)).toMatchObject({ incoming: 2, clients: 1, autoDispose: false })
  h.tick()
  await h.binding(current)
  expectAuthority(current, first.binding.characterId)
  expect(h.status(roomId)).toMatchObject({ active: 1, incoming: 1, clients: 1, autoDispose: false })
  await current.room.leave()
  await until(() => h.status(roomId).clients === 0, 'First committed arrival did not leave')
  expect(h.status(roomId)).toMatchObject({ active: 0, incoming: 1, clients: 0, autoDispose: false })
  const last = await h.candidate(second)
  h.tick()
  await h.binding(last)
  expectAuthority(last, second.binding.characterId)
  expect(h.status(roomId)).toMatchObject({ active: 1, incoming: 0, clients: 1, autoDispose: true })
})

test('counts active, grace and incoming seats toward 20, rejecting the 21st on both admission paths', async () => {
  const first = await h.fresh()
  const destinationId = first.room.roomId
  await Promise.all(Array.from({ length: 18 }, () => h.fresh(destinationId)))
  const source1 = await h.fresh()
  const source2 = await h.fresh(source1.room.roomId)
  const { roomId: villageId } = await h.createVillage()
  h.tick()
  await h.portal(source1, 'p_to_village')
  await h.portal(source2, 'p_to_village')
  h.tick()
  await until(() => source1.offer && source2.offer, 'Both actors need Village offers')
  expect(h.status(villageId)).toMatchObject({ incoming: 2, clients: 0, transportReservations: 0, autoDispose: false })
  const [village1, village2] = await Promise.all([h.candidate(source1), h.candidate(source2)])
  h.tick()
  await Promise.all([h.binding(village1), h.binding(village2), h.empty(source1.room.roomId)])
  expect(village1.room.roomId).toBe(villageId)
  await first.room.leave(false)
  await until(() => h.status(destinationId).grace === 1, 'Missing M1 grace seat')

  await h.portal(village1, 'p_to_m1')
  await h.portal(village2, 'p_to_m1')
  h.tick()
  await until(() => village1.offer && village2.failure, 'Missing offer or full-room rejection')
  expect(village1.offer.roomId).toBe(destinationId)
  expect(village2.failure.code).toBe('MAP_SEAT_UNAVAILABLE')
  expect(h.status(destinationId)).toMatchObject({ active: 18, grace: 1, incoming: 1, clients: 18, transportReservations: 0, locked: false })
  expect(h.runtime(destinationId).hasCapacity()).toBe(false)
  await expect(h.joinById(destinationId)).rejects.toThrow('MAP_SEAT_UNAVAILABLE')
  const arrival = await h.candidate(village1)
  h.tick()
  await h.binding(arrival)
  const grace = await h.reconnect(first)
  expectAuthority(arrival, village1.binding.characterId)
  expectAuthority(grace, first.binding.characterId)
  expectAuthority(village2)
  expect(h.status(destinationId)).toMatchObject({ active: 20, grace: 0, incoming: 0, clients: 20, locked: true, autoDispose: true })
  await expect(h.joinById(destinationId)).rejects.toMatchObject({ code: 522, message: expect.stringContaining('locked') })
}, 10_000)
