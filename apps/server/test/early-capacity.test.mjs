import { movementCheckpointMessage } from '@viesma/protocol'
import { createHistogram } from 'node:perf_hooks'
import { describe, expect, test, vi } from 'vitest'
import { observeSeats } from './capacity-audit.mjs'
import {
  createRoomMetrics,
  distribution,
  findAuthorizedInFlight,
  matchesOwner,
  observeCombat,
  observePrivateWrite,
  record,
} from './capacity-observe.mjs'

describe('early capacity observations', () => {
  test('requires evidence of a private message sent before its binding was revoked', () => {
    const binding = { characterId: 'p', connectionEpoch: 'source', mapEpoch: 0 }
    const payload = { ...binding, serverTick: 98 }
    expect(matchesOwner(binding, payload)).toBe(true)
    expect(matchesOwner({ ...binding, connectionEpoch: 'destination' }, payload)).toBe(false)
    const route = { revokedAt: 99, messages: new Map() }
    observePrivateWrite(route, movementCheckpointMessage, payload, 98)
    observePrivateWrite(route, movementCheckpointMessage, { ...payload, serverTick: 99 }, 99)
    expect(findAuthorizedInFlight(route, { type: movementCheckpointMessage, stamp: 98 })).toEqual({ stamp: 98, worldTick: 98 })
    expect(findAuthorizedInFlight(route, { type: movementCheckpointMessage, stamp: 99 })).toBeUndefined()
    expect(findAuthorizedInFlight(route, { type: movementCheckpointMessage, stamp: 97 })).toBeUndefined()
  })
  test('records in milliseconds and preserves empty histogram semantics', () => {
    const histogram = createHistogram()
    expect(distribution(histogram)).toEqual({ count: 0 })
    record(histogram, 0)
    record(histogram, 2.5)
    expect(distribution(histogram)).toMatchObject({ count: 2, p50: 0.000001 })
    expect(distribution(histogram).max).toBeCloseTo(2.5, 2)
  })

  test('observes a reserved seat across disconnect, reconnect and transfer', () => {
    const incident = vi.fn()
    const runtime = {
      roomId: 'map',
      map: { id: 'm1' },
      hasCapacity: () => true,
      join: () => ({ characterId: 'a' }),
      detach() {},
      rebind: () => ({ characterId: 'a' }),
      prepareDeparture: () => () => {},
      reserve: () => true,
      prepareArrival: () => () => {},
    }
    const metrics = createRoomMetrics(runtime)
    observeSeats(runtime, metrics, incident)
    runtime.join('socket-1', 0)
    runtime.detach('socket-1')
    expect(metrics.disconnected.has('a')).toBe(true)
    runtime.rebind('a', 'socket-2', 0)
    expect(metrics.disconnected.size).toBe(0)
    runtime.prepareDeparture('socket-2', 'a')()
    runtime.reserve('b')
    runtime.prepareArrival('socket-3', { characterId: 'b' })()
    expect([...metrics.connections.values()]).toEqual(['b'])
    expect(metrics.incoming.size).toBe(0)
    expect(metrics.seatsPeak).toBe(1)
    expect(metrics.reservedPeak).toBe(1)
    expect(incident).not.toHaveBeenCalled()
  })

  test('detects damage addressed to a replaced monster encounter or player life', () => {
    const incident = vi.fn()
    const room = createRoomMetrics({ roomId: 'map', map: { id: 'm1' } })
    room.tick = 12
    const player = { characterId: 'p', lifeStartedTick: 11, physics: { velocity: { y: 0 } } }
    const monster = {
      monsterId: 'm',
      encounterId: 'new',
      generation: 1,
      spawn: { spawnId: 'slime' },
      hp: 5,
      behavior: { action: { target: { characterId: 'p', lifeStartedTick: 4 } } },
    }
    const map = { players: [player], monsters: [monster] }
    room.generations.set('slime', 0)
    observeCombat(
      map,
      map,
      [
        { kind: 'monsterDamaged', monsterId: 'm', encounterId: 'old' },
        { kind: 'playerDamaged', monsterId: 'm', encounterId: 'new', characterId: 'p' },
      ],
      room,
      incident
    )
    expect(room.events.monsterRespawns).toBe(1)
    expect(incident.mock.calls.flat()).toEqual(['stale monster generation received damage', 'stale player life received damage'])
  })
})
