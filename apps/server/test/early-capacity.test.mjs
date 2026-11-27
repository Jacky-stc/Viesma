import { movementCheckpointMessage } from '@viesma/protocol'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistogram } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import {
  createRoomMetrics,
  distribution,
  findAuthorizedInFlight,
  matchesOwner,
  observeCombat,
  observePrivateWrite,
  record,
} from './capacity-observe.mjs'
import { observeSeats } from './capacity-seats.mjs'

function persistedSeatPeaks({ activePeak, reservedPeak, seatsPeak }) {
  return JSON.parse(JSON.stringify({ activePeak, reservedPeak, seatsPeak }))
}

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

  test('starts with empty seats and serializable zero peaks', () => {
    const metrics = observeSeats({ hasCapacity: () => true }, vi.fn())
    expect(metrics.connections.size).toBe(0)
    expect(metrics.disconnected.size).toBe(0)
    expect(metrics.incoming.size).toBe(0)
    expect(persistedSeatPeaks(metrics)).toEqual({ activePeak: 0, reservedPeak: 0, seatsPeak: 0 })
  })

  test('tracks seat peaks across the first join, grace reservation, transfer and release', () => {
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
      release() {},
    }
    const metrics = createRoomMetrics(runtime, incident)
    runtime.join('socket-1', 0)
    expect(persistedSeatPeaks(metrics)).toEqual({ activePeak: 1, reservedPeak: 0, seatsPeak: 1 })
    runtime.reserve('b')
    expect(persistedSeatPeaks(metrics)).toEqual({ activePeak: 1, reservedPeak: 1, seatsPeak: 2 })
    runtime.detach('socket-1')
    expect(persistedSeatPeaks(metrics)).toEqual({ activePeak: 1, reservedPeak: 2, seatsPeak: 2 })
    expect(metrics.disconnected.has('a')).toBe(true)
    runtime.rebind('a', 'socket-2', 0)
    expect(metrics.disconnected.size).toBe(0)
    runtime.prepareDeparture('socket-2', 'a')()
    runtime.prepareArrival('socket-3', { characterId: 'b' })()
    expect([...metrics.connections.values()]).toEqual(['b'])
    expect(metrics.incoming.size).toBe(0)
    runtime.detach('socket-3')
    runtime.release('b')
    expect(metrics.connections.size + metrics.disconnected.size + metrics.incoming.size).toBe(0)
    expect(persistedSeatPeaks(metrics)).toEqual({ activePeak: 1, reservedPeak: 2, seatsPeak: 2 })
    expect(incident).not.toHaveBeenCalled()
  })

  test('detects damage addressed to a replaced monster encounter or player life', () => {
    const incident = vi.fn()
    const room = createRoomMetrics({ roomId: 'map', map: { id: 'm1' } }, incident)
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

describe('early capacity CLI validation', () => {
  const cli = fileURLToPath(new URL('./run-early-capacity.mjs', import.meta.url))

  test.each([
    ['constructor stage', ['--stage', 'constructor']],
    ['toString stage', ['--stage', 'toString']],
    ['__proto__ stage', ['--stage', '__proto__']],
    ['**proto** stage', ['--stage', '**proto**']],
    ['unknown stage', ['--stage', 'D']],
    ['empty stage', ['--stage=']],
    ['non-positive duration', ['--seconds', '0']],
    ['negative warmup', ['--warmup=-1']],
    ['empty warmup', ['--warmup=']],
    ['unknown option', ['--unexpected']],
  ])('rejects %s without changing existing output bytes', (_label, args) => {
    const directory = mkdtempSync(join(tmpdir(), 'viesma-capacity-cli-'))
    const output = join(directory, 'output.jsonl')
    const original = '{"kind":"prior-result"}\n'
    try {
      writeFileSync(output, original)
      const result = spawnSync(process.execPath, [cli, '--output', output, ...args], { encoding: 'utf8', timeout: 4000 })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/Usage: node apps\/server\/test\/run-early-capacity\.mjs|ERR_PARSE_ARGS_UNKNOWN_OPTION/)
      expect(result.stdout).toBe('')
      expect(readFileSync(output, 'utf8')).toBe(original)
    } finally {
      rmSync(output, { force: true })
      rmdirSync(directory)
    }
  })

  test('does not create a new output file for invalid arguments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'viesma-capacity-cli-'))
    const output = join(directory, 'output.jsonl')
    try {
      const result = spawnSync(process.execPath, [cli, '--output', output, '--stage', 'constructor'], { encoding: 'utf8', timeout: 4000 })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Usage: node apps/server/test/run-early-capacity.mjs')
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(output, { force: true })
      rmdirSync(directory)
    }
  })
})
