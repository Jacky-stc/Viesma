import { loadGrayboxGameData } from '@viesma/game-data'
import { parseMovementCheckpoint, PROTOCOL_VERSION } from '@viesma/protocol'
import { createFixedTickDriver, createPlayer, createPlayerController, fixedDeltaSeconds } from '@viesma/simulation'
import { expect, test } from 'vitest'
import { createMapRuntime } from '../../server/src/runtime/map-runtime.ts'
import { createCorrectionPresentation } from '../src/multiplayer/correction-presentation.ts'
import { createLocalPrediction, inputHistoryCapacity } from '../src/multiplayer/local-prediction.ts'

const m1 = loadGrayboxGameData().tiledMaps.find(({ id }) => id === 'm1')
const bounds = { origin: { x: 0, y: 0 }, width: 2000, height: 500 }
const floor = { kind: 'solid', bounds: { origin: { x: 0, y: 300 }, width: 2000, height: 100 } }
const ledge = { kind: 'solid', bounds: { origin: { x: 20, y: 140 }, width: 160, height: 25 } }
const map = { ...m1, bounds, colliders: [floor, ledge] }
const binding = { characterId: 'beginner', connectionEpoch: 'connection', mapEpoch: 0 }
const roomId = 'fixture-room'
const neutral = { moveX: 0, jumpPressed: false, attackPressed: false }
const runRight = { ...neutral, moveX: 1 }
const start = { x: 300, y: 252 }
const controller = createPlayerController(map)
const { position, physics, movement, facing, locomotion, action, lastHurtTick } = createPlayer(binding.characterId, start, true)
const initial = { position, physics, movement, facing, locomotion, action, lastHurtTick }

function checkpoint(serverTick, ackInputSeq = null, state = initial, fields = {}) {
  return {
    ...binding,
    protocolVersion: PROTOCOL_VERSION,
    mapInstanceId: roomId,
    lifeStartedTick: 0,
    serverTick,
    ackInputSeq,
    controller: state,
    ...fields,
  }
}

test('predicts on the next fixed step and sends only normalized input without mutating a checkpoint', () => {
  const prediction = createLocalPrediction(map, roomId, binding)
  expect(prediction.step(runRight, 1)).toBeUndefined()
  const wire = checkpoint(10)
  const source = parseMovementCheckpoint(wire)
  Object.freeze(source.controller)
  Object.freeze(source.controller.physics.velocity)
  Object.freeze(source.controller.movement)
  expect(prediction.receive(source)).toBe('reset')
  const frame = prediction.step(runRight, 1)
  expect(frame).toEqual({ protocolVersion: PROTOCOL_VERSION, connectionEpoch: binding.connectionEpoch, mapEpoch: 0, seq: 1, ...runRight })
  expect(prediction.predicted).toMatchObject({ tick: 11, controller: { position: { x: 302, y: 252 }, locomotion: 'run' } })
  expect(source).toEqual(wire)
  expect(source.controller.position).toEqual(start)
})

test('replays a coyote jump from a full checkpoint, retaining the reserved attack edge without side effects', () => {
  const prediction = createLocalPrediction(map, roomId, binding)
  const onEdge = { ...initial, position: { x: 177, y: 92 } }
  prediction.receive(checkpoint(10, null, onEdge))
  const first = prediction.step(runRight, 1)
  const second = prediction.step(runRight, 2)
  const third = prediction.step({ ...runRight, jumpPressed: true, attackPressed: true }, 3)
  prediction.step(runRight, 4)
  const atEdge = controller(controller(onEdge, first, undefined, 11), second, undefined, 12)
  expect(atEdge).toMatchObject({ physics: { grounded: false }, movement: { coyoteTicksRemaining: 3 } })
  expect(third).toMatchObject({ seq: 3, jumpPressed: true, attackPressed: true })
  const expected = globalThis.structuredClone(prediction.predicted)
  expect(prediction.receive(checkpoint(12, 2, atEdge))).toBe('reconciled')
  expect(prediction.predicted).toEqual(expected)
  expect(prediction.predicted.controller).toMatchObject({ locomotion: 'jump', action: { kind: 'none' } })
  expect(prediction.diagnostics).toMatchObject({ ackInputSeq: 2, replayedInputs: 2, pendingInputs: 2, lastCorrectionWorldUnits: 0 })
})

test('restores action timing before replay and applies a newly finalized gap without replaying discarded edges', () => {
  const prediction = createLocalPrediction(map, roomId, binding)
  prediction.receive(checkpoint(10))
  prediction.step({ ...runRight, jumpPressed: true, attackPressed: true }, 1)
  const next = prediction.step({ ...runRight, jumpPressed: true }, 2)
  const hurt = { ...initial, position: { x: 290, y: 252 }, action: { kind: 'hurt', ticksRemaining: 3 }, lastHurtTick: 11 }
  expect(prediction.receive(checkpoint(11, 1, hurt))).toBe('reconciled')
  expect(prediction.predicted.controller).toEqual(controller(hurt, next, undefined, 12))
  expect(prediction.predicted.controller).toMatchObject({
    position: { x: 292, y: 252 },
    action: { kind: 'hurt', ticksRemaining: 2 },
    movement: { lastProcessedInputSeq: 2, jumpBufferTicksRemaining: 0 },
  })
  const attacking = { ...hurt, facing: 'left', action: { kind: 'attack', facing: 'right' } }
  expect(prediction.receive(checkpoint(12, 2, attacking))).toBe('reconciled')
  expect(prediction.predicted.controller.action).toEqual({ kind: 'attack', facing: 'right' })
  expect(prediction.diagnostics.pendingInputs).toBe(0)
})

test('replays a buffered jump from the touchdown checkpoint after pruning the original edge', () => {
  const prediction = createLocalPrediction(map, roomId, binding)
  const falling = {
    ...initial,
    position: { x: 300, y: 250 },
    physics: { ...physics, grounded: false, velocity: { x: 0, y: 60 } },
    locomotion: 'fall',
  }
  prediction.receive(checkpoint(10, null, falling))
  const edge = prediction.step({ ...neutral, jumpPressed: true }, 1)
  prediction.step(neutral, 2)
  const landed = controller(falling, edge, undefined, 11)
  expect(landed).toMatchObject({ physics: { grounded: true }, movement: { jumpBufferTicksRemaining: 3 } })
  const expected = prediction.predicted
  expect(prediction.receive(checkpoint(11, 1, landed))).toBe('reconciled')
  expect(prediction.predicted).toEqual(expected)
  expect(prediction.predicted.controller).toMatchObject({ locomotion: 'jump', movement: { jumpBufferTicksRemaining: 0 } })
})

test('rejects duplicate ticks and stale acknowledgement boundaries while accepting a newer tick with the same ack', () => {
  const prediction = createLocalPrediction(map, roomId, binding)
  prediction.receive(checkpoint(10))
  const first = prediction.step(runRight, 1)
  prediction.step(neutral, 2)
  const applied = controller(initial, first, undefined, 11)
  expect(prediction.receive(checkpoint(11, 1, applied))).toBe('reconciled')
  for (const stale of [
    checkpoint(11, 1, applied),
    checkpoint(9, 2),
    checkpoint(12),
    checkpoint(12, 3),
    checkpoint(12, 1, applied, { connectionEpoch: 'obsolete' }),
    checkpoint(12, 1, applied, { mapInstanceId: 'other-room' }),
  ])
    expect(prediction.receive(stale)).toBe('ignored')
  expect(prediction.diagnostics).toMatchObject({ ackInputSeq: 1, pendingInputs: 1 })
  const later = controller(applied, undefined, undefined, 12)
  expect(prediction.receive(checkpoint(12, 1, later))).toBe('reconciled')
  expect(prediction.predicted.tick).toBe(13)
  expect(prediction.diagnostics.pendingInputs).toBe(1)
})

test('validates checkpoint payloads, including missing ack and invalid controller fields', () => {
  const valid = checkpoint(10)
  expect(parseMovementCheckpoint(valid)).toEqual(valid)
  const missingAck = { ...valid }
  delete missingAck.ackInputSeq
  for (const invalid of [
    missingAck,
    { ...valid, serverTick: -1 },
    { ...valid, lifeStartedTick: 11 },
    { ...valid, controller: { ...initial, physics: { ...initial.physics, grounded: 'true' } } },
    { ...valid, controller: { ...initial, position: { x: NaN, y: 0 } } },
    { ...valid, controller: { ...initial, movement: { ...movement, lastProcessedInputSeq: 1 } } },
    { ...valid, controller: { ...initial, movement: { ...movement, lastInputTick: 11 } } },
  ])
    expect(parseMovementCheckpoint(invalid)).toBeUndefined()
})

test('bounds history during missing acknowledgement, snaps back on overflow, and resumes only from a fresh checkpoint', () => {
  const prediction = createLocalPrediction(map, roomId, binding)
  prediction.receive(checkpoint(10))
  for (let tick = 1; tick <= inputHistoryCapacity; tick++) {
    expect(prediction.step(neutral, tick)?.seq).toBe(tick)
  }
  expect(prediction.receive(checkpoint(11))).toBe('reconciled')
  expect(prediction.diagnostics).toMatchObject({ pendingInputs: inputHistoryCapacity, ackInputSeq: null })
  expect(prediction.step(neutral, 121)).toBeUndefined()
  expect(prediction.predicted).toEqual({ tick: 11, controller: initial })
  expect(prediction.diagnostics).toMatchObject({ pendingInputs: 0, historyOverflows: 1 })
  expect(prediction.receive(checkpoint(11))).toBe('ignored')
  expect(prediction.step(neutral, 122)).toBeUndefined()
  expect(prediction.receive(checkpoint(12))).toBe('reset')
  expect(prediction.step(runRight, 123)?.seq).toBe(121)
})

test('clears inputs across teleport epochs, Death, new life, suspension and disconnect', () => {
  const prediction = createLocalPrediction(map, roomId, binding)
  prediction.receive(checkpoint(10))
  prediction.step(runRight, 1)
  const teleported = { ...initial, position: { x: 312, y: 252 } }
  expect(prediction.receive(checkpoint(11, 1, teleported, { mapEpoch: 1 }))).toBe('reset')
  expect(prediction.predicted.controller.position).toEqual(teleported.position)
  expect(prediction.diagnostics.pendingInputs).toBe(0)
  expect(prediction.receive(checkpoint(12, 1))).toBe('ignored')
  expect(prediction.step(runRight, 2)).toMatchObject({ seq: 2, mapEpoch: 1 })
  const dead = { ...teleported, action: { kind: 'death', diedAtTick: 13 } }
  expect(prediction.receive(checkpoint(13, 2, dead, { mapEpoch: 1 }))).toBe('reset')
  expect(prediction.diagnostics.pendingInputs).toBe(0)
  expect(prediction.step(runRight, 3)).toBeUndefined()
  expect(prediction.receive(checkpoint(14, 2, teleported, { mapEpoch: 1 }))).toBe('ignored')
  expect(prediction.receive(checkpoint(103, 2, initial, { mapEpoch: 1, lifeStartedTick: 103 }))).toBe('reset')
  prediction.step(runRight, 4)
  prediction.suspend()
  expect(prediction.diagnostics.pendingInputs).toBe(0)
  expect(prediction.step(runRight, 5)).toBeUndefined()
  prediction.dispose()
  expect(prediction.predicted).toBeUndefined()
  expect(prediction.receive(checkpoint(104, 2, initial, { mapEpoch: 1, lifeStartedTick: 103 }))).toBe('ignored')
  const rejoined = { ...binding, connectionEpoch: 'new-connection' }
  const replacement = createLocalPrediction(map, roomId, rejoined)
  expect(replacement.receive(checkpoint(105))).toBe('ignored')
  expect(replacement.receive(checkpoint(105, null, initial, rejoined))).toBe('reset')
  expect(replacement.step(neutral, 1)).toMatchObject({ seq: 1, connectionEpoch: rejoined.connectionEpoch })
})

test('wall correction snaps across a solid, while a small clear correction decays in 100 ms and a large one snaps', () => {
  const wall = { kind: 'solid', bounds: { origin: { x: 350, y: 200 }, width: 8, height: 100 } }
  const walledMap = { ...map, colliders: [...map.colliders, wall] }
  const prediction = createLocalPrediction(walledMap, roomId, binding)
  const shown = createCorrectionPresentation(walledMap)
  prediction.receive(checkpoint(10))
  for (let tick = 1; tick <= 10; tick++) prediction.step(runRight, tick)
  const left = prediction.predicted.controller.position
  expect(left.x).toBe(326)
  expect(prediction.receive(checkpoint(20, 10, { ...initial, position: { x: 360, y: 252 } }))).toBe('reconciled')
  const right = prediction.predicted.controller.position
  expect(shown.correct(left, right, 0)).toBe(false)
  expect([0, 16, 40, 100].map((time) => shown.positionAt(right, time))).toEqual(Array(4).fill(right))
  expect(shown.correct(right, { x: 380, y: 252 }, 100)).toBe(true)
  expect([100, 150, 200].map((time) => shown.positionAt({ x: 380, y: 252 }, time).x)).toEqual([360, 370, 380])
  expect(shown.correct({ x: 306, y: 252 }, { x: 320, y: 252 }, 205)).toBe(true)
  expect(shown.positionAt(right, 215)).toEqual(right)
  expect(prediction.receive(checkpoint(21, 10, { ...initial, position: { x: 440, y: 252 } }))).toBe('snap')
  expect(shown.correct(right, { x: 440, y: 252 }, 210)).toBe(false)
})

test('replays an outstanding jump from a runtime checkpoint, then converges after the burst is settled', () => {
  let nextId = 0
  const room = createMapRuntime(roomId, map, { position: start, facing: 'right' }, 'hash', 0, () => `id-${++nextId}`)
  const connection = {}
  const joined = room.join(connection, 0)
  const prediction = createLocalPrediction(map, roomId, joined)
  room.advance({ tick: 1, dtSeconds: fixedDeltaSeconds }, 34)
  expect(prediction.receive(parseMovementCheckpoint(room.checkpoint(connection)))).toBe('reset')
  const frames = [prediction.step({ ...neutral, jumpPressed: true }, 1)]
  for (let seq = 2; seq <= 7; seq++) frames.push(prediction.step(neutral, seq))

  room.advance({ tick: 2, dtSeconds: fixedDeltaSeconds }, 67)
  const pending = parseMovementCheckpoint(room.checkpoint(connection))
  expect(pending).toMatchObject({ ackInputSeq: null, controller: { physics: { grounded: true } } })
  expect(prediction.receive(pending)).toBe('reconciled')
  expect(prediction.diagnostics.replayedInputs).toBe(7)
  expect(prediction.predicted.controller.locomotion).toBe('jump')

  for (const frame of frames) expect(room.receive(connection, frame, 70)).toBe(true)
  room.advance({ tick: 3, dtSeconds: fixedDeltaSeconds }, 100)
  const applied = parseMovementCheckpoint(room.checkpoint(connection))
  expect(applied).toMatchObject({ ackInputSeq: 2, controller: { locomotion: 'jump', movement: { lastProcessedInputSeq: 1 } } })
  expect(prediction.receive(applied)).toBe('reconciled')
  expect(prediction.diagnostics).toMatchObject({ pendingInputs: 5, replayedInputs: 5 })

  for (let tick = 4; tick <= 8; tick++) room.advance({ tick, dtSeconds: fixedDeltaSeconds }, (1000 * tick) / 30)
  const final = parseMovementCheckpoint(room.checkpoint(connection))
  expect(prediction.receive(final)).toBe('reconciled')
  expect(prediction.diagnostics).toMatchObject({ ackInputSeq: 7, pendingInputs: 0, replayedInputs: 0 })
  expect(prediction.predicted).toEqual({ tick: final.serverTick, controller: final.controller })
})

test('prunes an expired predicted jump without replaying it after the runtime resolves its sequence', () => {
  let nextId = 0
  const room = createMapRuntime(roomId, map, { position: start, facing: 'right' }, 'hash', 0, () => `id-${++nextId}`)
  const connection = {}
  const joined = room.join(connection, 0)
  const prediction = createLocalPrediction(map, roomId, joined)
  room.advance({ tick: 1, dtSeconds: fixedDeltaSeconds }, 34)
  expect(prediction.receive(parseMovementCheckpoint(room.checkpoint(connection)))).toBe('reset')
  const jump = prediction.step({ ...neutral, jumpPressed: true }, 1)
  expect(prediction.predicted.controller.locomotion).toBe('jump')
  expect(room.receive(connection, jump, 40)).toBe(true)
  room.advance({ tick: 2, dtSeconds: fixedDeltaSeconds }, 241)
  const expired = parseMovementCheckpoint(room.checkpoint(connection))
  expect(expired).toMatchObject({
    ackInputSeq: 1,
    controller: { physics: { grounded: true }, movement: { lastProcessedInputSeq: null, jumpBufferTicksRemaining: 0 } },
  })
  expect(prediction.receive(expired)).toBe('reconciled')
  expect(prediction.diagnostics).toMatchObject({ pendingInputs: 0, replayedInputs: 0 })
  expect(prediction.predicted).toEqual({ tick: expired.serverTick, controller: expired.controller })
})

test('restores an accepted runtime jump buffer after pruning its edge and keeps it across a delayed wake', () => {
  let nextId = 0
  const room = createMapRuntime(roomId, map, { position: start, facing: 'right' }, 'hash', 0, () => `id-${++nextId}`)
  const connection = {}
  const joined = room.join(connection, 0)
  const prediction = createLocalPrediction(map, roomId, joined)
  room.advance({ tick: 1, dtSeconds: fixedDeltaSeconds }, 34)
  expect(prediction.receive(parseMovementCheckpoint(room.checkpoint(connection)))).toBe('reset')
  expect(room.receive(connection, prediction.step({ ...neutral, jumpPressed: true }, 1), 40)).toBe(true)
  for (let tick = 2; tick < 20; tick++) room.advance({ tick, dtSeconds: fixedDeltaSeconds }, (1000 * tick) / 30)
  const falling = parseMovementCheckpoint(room.checkpoint(connection))
  expect(falling).toMatchObject({ ackInputSeq: 1, controller: { locomotion: 'fall' } })
  expect(prediction.receive(falling)).toBe('reconciled')

  expect(room.receive(connection, prediction.step({ ...neutral, jumpPressed: true }, 2), 650)).toBe(true)
  expect(room.receive(connection, prediction.step(neutral, 3), 660)).toBe(true)
  const locallyPredicted = prediction.predicted
  room.advance({ tick: 20, dtSeconds: fixedDeltaSeconds }, 667)
  const landed = parseMovementCheckpoint(room.checkpoint(connection))
  expect(landed).toMatchObject({
    ackInputSeq: 2,
    controller: { physics: { grounded: true }, movement: { lastProcessedInputSeq: 2, jumpBufferTicksRemaining: 3 } },
  })
  expect(prediction.receive(landed)).toBe('reconciled')
  expect(prediction.diagnostics).toMatchObject({ pendingInputs: 1, replayedInputs: 1 })
  expect(prediction.predicted).toEqual(locallyPredicted)
  expect(prediction.predicted.controller.locomotion).toBe('jump')

  room.advance({ tick: 21, dtSeconds: fixedDeltaSeconds }, 900)
  const jumped = parseMovementCheckpoint(room.checkpoint(connection))
  expect(jumped).toMatchObject({
    ackInputSeq: 3,
    controller: { locomotion: 'jump', movement: { lastProcessedInputSeq: 2, jumpBufferTicksRemaining: 0 } },
  })
  expect(prediction.receive(jumped)).toBe('reconciled')
  expect(prediction.diagnostics).toMatchObject({ pendingInputs: 0, replayedInputs: 0 })
  expect(prediction.predicted).toEqual({ tick: jumped.serverTick, controller: jumped.controller })
})

test.each([false, true])('converges with 150 ms RTT (jitter %s) at different render rates', (jitter) => {
  function trace(renderInterval) {
    let nextId = 0
    const room = createMapRuntime(roomId, map, { position: start, facing: 'right' }, 'hash', 0, () => `id-${++nextId}`)
    const connection = {}
    const joined = room.join(connection, 0)
    const prediction = createLocalPrediction(map, roomId, joined)
    const presentation = createCorrectionPresentation(map)
    const upstream = []
    const downstream = []
    const sent = []
    let maxPending = 0
    let now = 0
    function delay(queue, tick, payload) {
      const variation = jitter ? [-24, 9, 0, 24, -9][tick % 5] : 0
      const due = Math.max(queue.at(-1)?.due ?? 0, now + 75 + variation)
      queue.push({ due, payload })
    }
    const server = createFixedTickDriver({ nowMilliseconds: () => now }, ({ tick }) => {
      room.advance({ tick, dtSeconds: fixedDeltaSeconds }, now)
      if (tick % 3 === 0) delay(downstream, tick, parseMovementCheckpoint(room.checkpoint(connection)))
    })
    const client = createFixedTickDriver({ nowMilliseconds: () => now }, ({ tick }) => {
      const intent = { ...neutral, moveX: tick < 20 ? 1 : tick < 34 ? -1 : 0, jumpPressed: tick === 11, attackPressed: tick === 11 }
      const frame = prediction.step(intent, tick)
      if (frame) {
        sent.push(frame)
        delay(upstream, tick, frame)
        maxPending = Math.max(maxPending, prediction.diagnostics.pendingInputs)
      }
    })
    for (now = 1; now <= 3100; now++) {
      while (upstream[0]?.due <= now) expect(room.receive(connection, upstream.shift().payload, now)).toBe(true)
      while (downstream[0]?.due <= now) {
        const previous = prediction.predicted?.controller.position
        const result = prediction.receive(downstream.shift().payload)
        if (result === 'reconciled' && previous && prediction.diagnostics.lastCorrectionWorldUnits > 0) {
          presentation.correct(previous, prediction.predicted.controller.position, now)
        } else if (result === 'snap' || result === 'reset') {
          presentation.reset()
        }
      }
      if (now <= 3000) server.advance()
      if (now <= 2100) client.advance()
      if (now % renderInterval === 0 && prediction.predicted) presentation.positionAt(prediction.predicted.controller.position, now)
    }
    const final = room.checkpoint(connection)
    expect(maxPending).toBeGreaterThanOrEqual(5)
    expect(sent.filter(({ jumpPressed }) => jumpPressed)).toHaveLength(1)
    expect(sent.filter(({ attackPressed }) => attackPressed)).toHaveLength(1)
    expect(prediction.diagnostics).toMatchObject({ ackInputSeq: sent.at(-1).seq, pendingInputs: 0 })
    expect(prediction.predicted).toEqual({ tick: final.serverTick, controller: final.controller })
    return { sent, final }
  }
  expect(trace(7)).toEqual(trace(62))
})
