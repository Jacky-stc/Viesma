import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { createDestinationRoom, createMapRoomClass } from '../dist/adapters/map-room.js'
import { createWorldCoordinator } from '../dist/runtime/world-coordinator.js'
import { enterLastDepartureWindow, startTransferFixture, until } from './transfer-lifecycle-fixture.mjs'

const baseline = process.argv.includes('--baseline')
const h = await startTransferFixture(createWorldCoordinator, createMapRoomClass, createDestinationRoom)
try {
  const { second, roomId } = await enterLastDepartureWindow(h)
  const characterId = second.binding.characterId
  const source = h.runtime(second.room.roomId)
  const oldSocket = h.socket(second)
  assert.ok(source.player(characterId))
  let admission
  if (baseline) {
    await h.empty(roomId)
    await assert.rejects(h.candidate(second), (error) => {
      admission = { code: error.code, message: error.message }
      return error.code === 522 && error.message.includes('not found')
    })
    h.tick()
    const failure = await until(() => second.failure, 'Missing failure in source')
    assert.equal(failure.code, 'TRANSFER_FAILED')
    assert.ok(source.player(characterId))
    assert.deepEqual(h.incidents, ['Disposed with retained application seats', 'Authoritative seat accounting/cap mismatch'])
    console.log(
      JSON.stringify({ roomId, events: h.events.filter((event) => event.roomId === roomId), admission, failure, sourceBodyPreserved: true })
    )
  } else {
    const pending = h.status(roomId)
    assert.equal(pending.incoming, 1)
    assert.equal(pending.clients, 0)
    assert.equal(pending.transportReservations, 0)
    assert.equal(pending.autoDispose, false)
    const candidate = await h.candidate(second)
    assert.equal(h.status(roomId).incoming, 1)
    assert.ok(source.player(characterId))
    assert.equal(h.runtime(roomId).player(characterId), undefined)
    h.tick()
    const arrival = await h.binding(candidate)
    assert.equal(arrival.characterId, characterId)
    assert.equal(arrival.mapEpoch, second.binding.mapEpoch + 1)
    assert.equal(h.status(roomId).incoming, 0)
    assert.equal(h.status(roomId).autoDispose, true)
    assert.equal(source.player(characterId), undefined)
    assert.equal(h.world.checkpoint(source, oldSocket), undefined)
    assert.equal(h.world.inventory(source, oldSocket), undefined)
    assert.equal(h.world.ownerGroundLoot(source, oldSocket), undefined)
    assert.equal(second.failure, undefined)
    await candidate.room.leave()
    await h.empty(roomId)
    assert.deepEqual(h.incidents, [])
    console.log(
      JSON.stringify({ roomId, events: h.events.filter((event) => event.roomId === roomId), handoffCompleted: true, unexpected522: 0 })
    )
  }
} finally {
  await h.close()
}
