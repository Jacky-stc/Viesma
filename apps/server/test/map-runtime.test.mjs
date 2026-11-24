import { loadGrayboxGameData } from '@viesma/game-data'
import { PROTOCOL_VERSION } from '@viesma/protocol'
import { fixedDeltaSeconds } from '@viesma/simulation'
import { expect, test, vi } from 'vitest'
import { createMapRuntime } from '../src/runtime/map-runtime.ts'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'

const gameData = loadGrayboxGameData()
const m1 = gameData.tiledMaps.find(({ id }) => id === 'm1')

function harness() {
  let now = 0
  let next = 0
  let callback
  const onBacklog = vi.fn()
  const onBacklogRecovered = vi.fn()
  const stop = vi.fn(() => {
    callback = undefined
  })
  const schedule = vi.fn((wake) => {
    callback = wake
    return stop
  })
  const world = createWorldCoordinator(gameData, 'fixture-hash', {
    clock: { nowMilliseconds: () => now },
    nextId: () => `id-${++next}`,
    onBacklog,
    onBacklogRecovered,
    schedule,
  })
  return {
    world,
    schedule,
    stop,
    onBacklog,
    onBacklogRecovered,
    wake(milliseconds) {
      now = milliseconds
      callback?.()
    },
  }
}

function frame(binding, seq, movement = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    connectionEpoch: binding.connectionEpoch,
    mapEpoch: binding.mapEpoch,
    seq,
    moveX: 1,
    jumpPressed: false,
    attackPressed: false,
    ...movement,
  }
}

test('runs one shared 30 Hz driver, bounds catch-up and stops with the last room', () => {
  const { world, schedule, stop, onBacklog, onBacklogRecovered, wake } = harness()
  const first = world.createRoom()
  wake(33)
  expect(first.snapshot().serverTick).toBe(0)
  wake(1000 / 30)
  const second = world.createRoom()
  expect(second.snapshot().serverTick).toBe(1)
  expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1000 / 30)

  wake(1000)
  expect(first.snapshot().serverTick).toBe(6)
  expect(second.snapshot().serverTick).toBe(6)
  expect(onBacklog).toHaveBeenCalledExactlyOnceWith(24)
  expect(world.tickDiagnostics()).toMatchObject({ backlogTicks: 24, catchUpTicks: 4 })
  expect(world.canAdmit()).toBe(false)
  wake(1040)
  expect(world.tickDiagnostics().backlogTicks).toBe(20)
  for (let index = 0; index < 4; index++) wake(1040)
  expect(second.snapshot().serverTick).toBe(31)
  expect(world.canAdmit()).toBe(true)
  expect(world.tickDiagnostics()).toEqual({ backlogTicks: 0, catchUpTicks: 24, lastBacklogRecoveryMilliseconds: 40 })
  expect(onBacklogRecovered).toHaveBeenCalledExactlyOnceWith(40, 24)

  world.disposeRoom(first)
  world.disposeRoom(first)
  expect(stop).not.toHaveBeenCalled()
  wake(1100)
  expect(first.snapshot().serverTick).toBe(31)
  expect(second.snapshot().serverTick).toBe(33)
  world.disposeRoom(second)
  expect(stop).toHaveBeenCalledOnce()
  wake(6000)
  const third = world.createRoom()
  expect(third.mapInstanceId).not.toBe(first.mapInstanceId)
  expect(third.snapshot().serverTick).toBe(33)
  wake(6100)
  expect(third.snapshot().serverTick).toBe(36)
  world.disposeRoom(third)
})

test('binds command ownership to the live connection and drops pending input on leave', () => {
  const { world, wake } = harness()
  const first = world.createRoom()
  const second = world.createRoom()
  const alpha = {}
  const bravo = {}
  const a = first.join(alpha, 0)
  const b = second.join(bravo, 0)
  expect(a.characterId).not.toBe(b.characterId)
  expect(first.join(alpha, 0)).toBeUndefined()
  expect(first.snapshot().players).toEqual([])
  wake(100)
  const spawn = first.snapshot().players[0]
  expect(spawn).toMatchObject({ hp: 50, maxHp: 50, state: 'idle' })
  expect(second.snapshot().players.map(({ characterId }) => characterId)).toEqual([b.characterId])

  const valid = frame(a, 0, { jumpPressed: true })
  for (const malformed of [
    null,
    [],
    { ...valid, seq: -1 },
    { ...valid, seq: NaN },
    { ...valid, seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, moveX: 0.5 },
    { ...valid, jumpPressed: 1 },
    { ...valid, attackPressed: 'false' },
    { ...valid, protocolVersion: 999 },
    { ...valid, mapEpoch: 1 },
    { ...valid, connectionEpoch: b.connectionEpoch },
    { ...valid, characterId: b.characterId },
    { ...valid, x: 999999 },
    { ...valid, hp: 0 },
    { ...valid, velocity: { x: 4000, y: 0 } },
    { ...valid, mp: 0 },
    { ...valid, geometry: [] },
  ]) {
    expect(first.receive(alpha, malformed, 100)).toBe(false)
  }
  expect(first.receive(bravo, valid, 100)).toBe(false)
  expect(second.receive(bravo, valid, 100)).toBe(false)
  wake(200)
  expect(first.snapshot().players[0]).toEqual(spawn)

  expect(first.receive(alpha, frame(a, 2, { jumpPressed: true }), 200)).toBe(true)
  expect(first.receive(alpha, frame(a, 2, { jumpPressed: true }), 200)).toBe(false)
  expect(first.receive(alpha, frame(a, 1), 200)).toBe(false)
  wake((1000 * 7) / 30)
  const jumped = first.snapshot().players[0]
  expect(jumped.x).toBeGreaterThan(spawn.x)
  expect(jumped.y).toBeLessThan(spawn.y)
  expect(jumped.hp).toBe(spawn.hp)
  expect(second.snapshot().players[0]).toMatchObject({ x: spawn.x, y: spawn.y })
  expect(first.receive(alpha, frame(a, 2), 240)).toBe(false)
  expect(first.receive(alpha, frame(a, 3), 240)).toBe(true)
  first.leave(alpha)
  expect(first.checkpoint(alpha)).toBeUndefined()
  expect(first.receive(alpha, frame(a, 4), 240)).toBe(false)
  const rejoined = first.join(alpha, 240)
  expect(rejoined.characterId).not.toBe(a.characterId)
  expect(rejoined.connectionEpoch).not.toBe(a.connectionEpoch)
  expect(first.receive(alpha, frame(a, 5), 240)).toBe(false)
  wake(300)
  expect(first.snapshot().players).toEqual([{ ...spawn, characterId: rejoined.characterId }])
  expect(first.checkpoint(alpha)).toMatchObject({
    ...rejoined,
    ackInputSeq: null,
    controller: { movement: { lastProcessedInputSeq: null } },
  })
  world.disposeRoom(first)
  expect(first.snapshot().players).toEqual([])
  expect(first.join(alpha, 300)).toBeUndefined()
  expect(second.snapshot().players).toHaveLength(1)
  world.disposeRoom(second)
})

test('consumes ordered frames one per tick and acknowledges a conflicting duplicate without applying it', () => {
  const { world, wake } = harness()
  const room = world.createRoom()
  const connection = {}
  const binding = room.join(connection, 0)
  wake(1000 / 30)
  const spawn = room.snapshot().players[0]
  expect(room.receive(connection, frame(binding, 1, { jumpPressed: true }), 40)).toBe(true)
  expect(room.receive(connection, frame(binding, 2, { moveX: -1 }), 40)).toBe(true)
  expect(room.receive(connection, frame(binding, 2, { moveX: 1, attackPressed: true }), 40)).toBe(false)
  expect(room.receive(connection, frame(binding, 1, { jumpPressed: true }), 40)).toBe(false)
  wake((1000 * 2) / 30)
  expect(room.snapshot().players[0].y).toBeLessThan(spawn.y)
  expect(room.checkpoint(connection)).toMatchObject({ ackInputSeq: 1, controller: { movement: { lastProcessedInputSeq: 1 } } })
  wake(100)
  expect(room.checkpoint(connection)).toMatchObject({ ackInputSeq: 2, controller: { movement: { lastProcessedInputSeq: 1 } } })
  expect(room.receive(connection, frame(binding, 3), 101)).toBe(true)
  wake((1000 * 4) / 30)
  expect(room.snapshot().players[0].x).toBeGreaterThan(spawn.x)
  world.disposeRoom(room)
})

test('bounds ingress bursts and refills from the injected clock', () => {
  const { world } = harness()
  const room = world.createRoom()
  const connection = {}
  const binding = room.join(connection, 0)
  expect(room.receive(connection, frame(binding, Number.MAX_SAFE_INTEGER), 0)).toBe(false)
  for (let seq = 0; seq < 79; seq++) expect(room.receive(connection, frame(binding, seq), 0)).toBe(true)
  expect(room.receive(connection, frame(binding, 79), 24)).toBe(false)
  expect(room.receive(connection, frame(binding, 79), 25)).toBe(true)
  world.disposeRoom(room)
})

test('preserves a jump in a seven-frame burst, settles the evicted gap, and applies only one frame per tick', () => {
  const { world, wake } = harness()
  const room = world.createRoom()
  const alpha = {}
  const bravo = {}
  const a = room.join(alpha, 0)
  const b = room.join(bravo, 0)
  wake(1000 / 30)
  const jump = { moveX: -1, jumpPressed: true }
  expect(room.receive(alpha, frame(a, 1, jump), 40)).toBe(true)
  for (let seq = 2; seq <= 6; seq++) expect(room.receive(alpha, frame(a, seq), 40)).toBe(true)
  expect(room.receive(alpha, frame(a, 7, { moveX: 0 }), 40)).toBe(true)
  expect(room.receive(bravo, frame(b, 1, jump), 40)).toBe(true)
  expect(room.checkpoint(alpha).ackInputSeq).toBeNull()
  wake((1000 * 2) / 30)
  expect(room.checkpoint(alpha)).toMatchObject({
    ackInputSeq: 2,
    controller: { physics: { grounded: false }, locomotion: 'jump', movement: { moveX: -1, lastProcessedInputSeq: 1 } },
  })
  expect(room.checkpoint(alpha).controller).toEqual(room.checkpoint(bravo).controller)
  expect(room.receive(alpha, frame(a, 2, jump), 70)).toBe(false)
  for (let seq = 3; seq <= 7; seq++) {
    wake((1000 * seq) / 30)
    expect(room.checkpoint(alpha)).toMatchObject({ ackInputSeq: seq, controller: { movement: { lastProcessedInputSeq: seq } } })
    expect(room.checkpoint(alpha).controller.position.y).toBe(room.checkpoint(bravo).controller.position.y)
  }
  expect(room.checkpoint(alpha).controller.movement.moveX).toBe(0)
  world.disposeRoom(room)
})

test('rejects a tail behind six valid edges and settles it after draining without further input', () => {
  const { world, wake } = harness()
  const room = world.createRoom()
  const connection = {}
  const binding = room.join(connection, 0)
  wake(1000 / 30)
  for (let seq = 1; seq <= 6; seq++) {
    expect(room.receive(connection, frame(binding, seq, { attackPressed: true, jumpPressed: seq === 1 }), 40)).toBe(true)
  }
  const rejected = frame(binding, 7, { jumpPressed: true })
  expect(room.receive(connection, rejected, 40)).toBe(false)
  for (let seq = 1; seq <= 5; seq++) {
    wake((1000 * (seq + 1)) / 30)
    expect(room.checkpoint(connection)).toMatchObject({ ackInputSeq: seq, controller: { movement: { lastProcessedInputSeq: seq } } })
  }
  wake((1000 * 7) / 30)
  expect(room.checkpoint(connection)).toMatchObject({ ackInputSeq: 7, controller: { movement: { lastProcessedInputSeq: 6 } } })
  expect(room.receive(connection, rejected, 240)).toBe(false)
  wake((1000 * 8) / 30)
  expect(room.checkpoint(connection)).toMatchObject({ ackInputSeq: 7, controller: { movement: { lastProcessedInputSeq: 6 } } })
  world.disposeRoom(room)
})

test('evicts a conflicted edge before a valid edge when all pending frames carry edges', () => {
  const { world, wake } = harness()
  const room = world.createRoom()
  const connection = {}
  const binding = room.join(connection, 0)
  wake(1000 / 30)
  for (let seq = 1; seq <= 6; seq++) expect(room.receive(connection, frame(binding, seq, { attackPressed: true }), 40)).toBe(true)
  expect(room.receive(connection, frame(binding, 6, { attackPressed: true, jumpPressed: true }), 40)).toBe(false)
  expect(room.receive(connection, frame(binding, 7, { jumpPressed: true }), 40)).toBe(true)
  expect(room.receive(connection, frame(binding, 6, { attackPressed: true }), 40)).toBe(false)
  wake(200)
  expect(room.checkpoint(connection)).toMatchObject({
    ackInputSeq: 6,
    controller: { physics: { grounded: true }, movement: { lastProcessedInputSeq: 5 } },
  })
  wake((1000 * 7) / 30)
  expect(room.checkpoint(connection)).toMatchObject({
    ackInputSeq: 7,
    controller: { locomotion: 'jump', movement: { lastProcessedInputSeq: 7 } },
  })
  world.disposeRoom(room)
})

test('uses the original receipt time at the inclusive cutoff and expires whole frames before catch-up', () => {
  const { world, wake } = harness()
  const room = world.createRoom()
  const exact = {}
  const duplicate = {}
  const conflict = {}
  const a = room.join(exact, 0)
  const b = room.join(duplicate, 0)
  const c = room.join(conflict, 0)
  wake(1000 / 30)
  const jump = { jumpPressed: true }
  expect(room.receive(duplicate, frame(b, 1, jump), 99)).toBe(true)
  expect(room.receive(conflict, frame(c, 1, jump), 99)).toBe(true)
  expect(room.receive(exact, frame(a, 1, jump), 100)).toBe(true)
  expect(room.receive(duplicate, frame(b, 1, jump), 298)).toBe(false)
  expect(room.receive(conflict, frame(c, 1, { ...jump, moveX: -1 }), 299)).toBe(false)
  expect(room.receive(conflict, frame(c, 2, { moveX: 0 }), 299)).toBe(true)
  for (const connection of [exact, duplicate, conflict]) expect(room.checkpoint(connection).ackInputSeq).toBeNull()
  wake(300)
  expect(room.snapshot().serverTick).toBe(6)
  expect(world.canAdmit()).toBe(false)
  expect(room.checkpoint(exact)).toMatchObject({ ackInputSeq: 1, controller: { locomotion: 'jump', movement: { lastInputTick: 2 } } })
  expect(room.checkpoint(duplicate)).toMatchObject({
    ackInputSeq: 1,
    controller: { physics: { grounded: true }, movement: { moveX: 0, lastProcessedInputSeq: null, lastInputTick: null } },
  })
  expect(room.checkpoint(conflict)).toMatchObject({
    ackInputSeq: 2,
    controller: { physics: { grounded: true }, movement: { moveX: 0, lastProcessedInputSeq: 2, lastInputTick: 2 } },
  })
  expect(room.receive(duplicate, frame(b, 1, jump), 300)).toBe(false)
  wake(300)
  expect(world.canAdmit()).toBe(true)
  expect(room.checkpoint(duplicate).controller.physics.grounded).toBe(true)
  world.disposeRoom(room)
})

test('admits a fresh edge when all six queued edges have expired before ingress', () => {
  const { world, wake } = harness()
  const room = world.createRoom()
  const connection = {}
  const binding = room.join(connection, 0)
  wake(1000 / 30)
  for (let seq = 1; seq <= 6; seq++) expect(room.receive(connection, frame(binding, seq, { attackPressed: true }), 40)).toBe(true)
  expect(room.receive(connection, frame(binding, 7, { jumpPressed: true }), 241)).toBe(true)
  wake(241)
  expect(room.checkpoint(connection)).toMatchObject({
    ackInputSeq: 7,
    controller: { locomotion: 'jump', movement: { lastInputTick: 2, lastProcessedInputSeq: 7 } },
  })
  world.disposeRoom(room)
})

test('bounds unresolved inputs and drains the terminal frontier after sustained ingress above the tick rate', () => {
  const { world, wake } = harness()
  const room = world.createRoom()
  const connection = {}
  const binding = room.join(connection, 0)
  const accepted = []
  let seq = 0
  let ack = 0
  let rejected = 0
  for (let batch = 0; batch < 60; batch++) {
    const start = batch * 100
    for (let offset = 0; offset < 100; offset += 25) {
      if (room.receive(connection, frame(binding, ++seq, { attackPressed: true, moveX: 0 }), start + offset)) accepted.push(seq)
      else rejected++
    }
    expect(accepted.filter((sent) => sent > ack).length).toBeLessThanOrEqual(6)
    wake(start + 100)
    const checkpoint = room.checkpoint(connection)
    expect(checkpoint.serverTick).toBe((batch + 1) * 3)
    expect(checkpoint.ackInputSeq).toBeGreaterThanOrEqual(ack)
    expect(checkpoint.controller.movement.lastProcessedInputSeq).toBeLessThanOrEqual(checkpoint.ackInputSeq)
    ack = checkpoint.ackInputSeq
  }
  expect(rejected).toBeGreaterThan(0)
  wake(6200)
  wake(6200)
  expect(room.checkpoint(connection)).toMatchObject({
    ackInputSeq: seq,
    controller: { physics: { grounded: true }, action: { kind: 'none' } },
  })
  world.disposeRoom(room)
})

test('flushes queued input when the authority enters Death and rejects late frames from that life', () => {
  let next = 0
  const bounds = { origin: { x: 0, y: 0 }, width: 400, height: 60 }
  const room = createMapRuntime(
    'fixture-room',
    { ...m1, bounds, colliders: [] },
    { position: { x: 100, y: 75 }, facing: 'right' },
    'hash',
    0,
    () => `id-${++next}`
  )
  const connection = {}
  const binding = room.join(connection, 0)
  expect(room.receive(connection, frame(binding, 1), 0)).toBe(true)
  expect(room.receive(connection, frame(binding, 2, { jumpPressed: true }), 0)).toBe(true)
  room.advance({ tick: 1, dtSeconds: fixedDeltaSeconds }, 1000 / 30)
  expect(room.checkpoint(connection)).toMatchObject({
    ackInputSeq: 2,
    controller: { action: { kind: 'death', diedAtTick: 1 }, movement: { lastProcessedInputSeq: 1 } },
  })
  expect(room.receive(connection, frame(binding, 3, { jumpPressed: true }), 40)).toBe(false)
  room.advance({ tick: 2, dtSeconds: fixedDeltaSeconds }, 2000 / 30)
  expect(room.checkpoint(connection).ackInputSeq).toBe(2)
})

test('projects the room-owned fixture as detached values and clears only the disposed instance', () => {
  const { world, wake } = harness()
  const one = world.createRoom()
  const other = world.createRoom()
  const first = one.snapshot().monsters[0]
  const second = other.snapshot().monsters[0]
  expect(first).toMatchObject({ archetypeId: 'slime', x: 465, y: 896, state: 'patrol', hp: 71, maxHp: 71 })
  expect(second).toEqual({ ...first, monsterId: second.monsterId })
  expect(second.monsterId).not.toBe(first.monsterId)

  const player = {}
  const binding = one.join(player, 0)
  expect(one.receive(player, frame(binding, 0, { monsterId: first.monsterId, hp: 0, x: 0 }), 0)).toBe(false)
  expect(one.queueMonsterFixtureEvent('test-hp')).toBe(true)
  expect(one.queueMonsterFixtureEvent('test-hp')).toBe(false)
  expect(one.snapshot().monsters[0]).toEqual(first)
  first.x = -10000
  wake(100)
  expect(one.snapshot().monsters[0]).toMatchObject({ monsterId: first.monsterId, x: 471, hp: 35 })
  expect(other.snapshot().monsters[0]).toMatchObject({ monsterId: second.monsterId, x: 471, hp: 71 })
  expect(one.queueMonsterFixtureEvent('test-hp')).toBe(false)

  one.leave(player)
  wake(200)
  expect(one.snapshot()).toMatchObject({ players: [], monsters: [{ monsterId: first.monsterId, x: 477, hp: 35 }] })
  expect(one.queueMonsterFixtureEvent('remove')).toBe(true)
  expect(one.queueMonsterFixtureEvent('remove')).toBe(false)
  wake(300)
  expect(one.snapshot().monsters).toEqual([])
  expect(one.queueMonsterFixtureEvent('remove')).toBe(false)
  world.disposeRoom(one)

  world.disposeRoom(other)
  expect(other.snapshot().monsters).toEqual([])
  const fresh = world.createRoom()
  expect(fresh.snapshot().monsters[0]).toMatchObject({ x: 465, hp: 71 })
  expect(fresh.snapshot().monsters[0].monsterId).not.toBe(second.monsterId)
  world.disposeRoom(fresh)
})

test('replays the same multi-actor trace with regular and delayed clock wakes', () => {
  function replay(delayed) {
    const { world, wake } = harness()
    const room = world.createRoom()
    const one = {}
    const two = {}
    const a = room.join(one, 0)
    const b = room.join(two, 0)
    const trace = []
    for (let segment = 0; segment < 4; segment++) {
      const start = segment * 300
      room.receive(two, frame(b, segment, { moveX: -1 }), start)
      room.receive(one, frame(a, segment, { jumpPressed: segment === 1 }), start)
      const end = start + 300
      if (delayed) {
        wake(start + 100)
        wake(end)
        wake(end)
      } else {
        for (let index = 1; index <= 9; index++) wake(start + (1000 * index) / 30)
      }
      trace.push(room.snapshot())
    }
    world.disposeRoom(room)
    return trace
  }
  expect(replay(true)).toEqual(replay(false))
})
