import { createPhysicsStepper, maxPhysicsSpeed, maxWorldCoordinate, positionQuantum } from '@viesma/physics'
import { fixedDeltaSeconds } from '@viesma/simulation'
import { expect, test } from 'vitest'
import { balance, body, box, oneWay, solid, world } from './geometry-fixtures.mjs'

function move(step, body, horizontalSpeedUnitsPerSecond = 0, jumpPressed = false) {
  return step(body, { horizontalSpeedUnitsPerSecond, jumpPressed }, fixedDeltaSeconds)
}

function expectState(result, x, y, velocityX, velocityY, grounded = false, inVoid = false) {
  expect(result).toEqual({
    body: { ...body(x, y), velocity: { x: velocityX, y: velocityY } },
    grounded,
    inVoid,
  })
}

const noGravity = { ...balance, gravityUnitsPerSecondSquared: 0 }

test('applies gravity at 30 Hz and caps the downward speed', () => {
  const step = createPhysicsStepper(world(), balance)
  let current = body(0, -100)
  for (let tick = 1; tick <= 15; tick++) {
    const result = move(step, current)
    expectState(result, 0, -100 + tick * (tick + 1), 0, tick * 60)
    current = result.body
  }
  expectState(move(step, current), 0, 170, 0, 900)
  expectState(move(step, body(0, 0, maxPhysicsSpeed)), 0, 30, 0, 900)
})

test('applies signed horizontal speed with tick-end grid rounding', () => {
  const step = createPhysicsStepper(world(), noGravity)
  const speed = balance.runSpeedUnitsPerSecond
  const right = move(step, body(-2, 0), speed)
  expectState(right, 5 + 341 / 1024, 0, speed, 0)
  expectState(move(step, right.body, -speed), -2, 0, -speed, 0)

  const halfGridSpeed = (positionQuantum / 2) * 30
  expectState(move(step, body(0, 0), halfGridSpeed), positionQuantum, 0, halfGridSpeed, 0)
  expectState(move(step, body(0, 0), -halfGridSpeed), 0, 0, -halfGridSpeed, 0)
})

test('lands on a solid floor and stays in exact contact for 10,000 ticks', () => {
  const step = createPhysicsStepper(world(solid(-256, 64, 768, 1)), balance)
  let result = move(step, body(-12, 0, 600))
  expectState(result, -12, 16, 0, 0, true)
  const landed = result
  for (let tick = 0; tick < 10_000; tick++) result = move(step, result.body)
  expect(result).toEqual(landed)
})

test('jumps from exact support and ignores a new request in the air', () => {
  const step = createPhysicsStepper(world(solid(-32, 96, 96, 8)), balance)
  const jumped = move(step, body(0, 48), 120, true)
  expectState(jumped, 4, 30, 120, -540)
  expectState(move(step, jumped.body, 120, true), 8, 14, 120, -480)
  expectState(move(step, body(0, 48 - positionQuantum), 0, true), 0, 48, 0, 0, true)
})

test('hits both sides of a thin wall and preserves tangential movement', () => {
  const step = createPhysicsStepper(world(solid(32, -120, positionQuantum, 240)), balance)
  expectState(move(step, body(-50, 0), maxPhysicsSpeed), 8, 2, 0, 60)
  expectState(move(step, body(60, 0), -maxPhysicsSpeed), 32 + positionQuantum, 2, 0, 60)
  expectState(move(step, body(8, 0), -120), 4, 2, -120, 60)
})

test('hits the underside of a thin ceiling while preserving X movement', () => {
  const step = createPhysicsStepper(world(solid(-128, -32, 256, positionQuantum)), balance)
  expectState(move(step, body(0, 48, -maxPhysicsSpeed), 120), 4, -32 + positionQuantum, 120, 0)
})

test.each([solid, oneWay])('cannot tunnel downward through a one-grid-step platform (%p)', (platform) => {
  const step = createPhysicsStepper(world(platform(-40, 96, 80, positionQuantum)), {
    ...balance,
    terminalFallSpeedUnitsPerSecond: maxPhysicsSpeed,
  })
  expectState(move(step, body(0, -80, maxPhysicsSpeed)), 0, 48, 0, 0, true)
})

test('passes through one-way geometry from below and the side, then lands from above', () => {
  const step = createPhysicsStepper(world(oneWay(0, 80, 96, 2)), balance)
  expectState(move(step, body(8, 84, -1680)), 8, 30, 0, -1620)
  expectState(move(step, body(-32, 74), 1800), 28, 76, 1800, 60)
  expectState(move(step, body(8, 30, 120)), 8, 32, 0, 0, true)
  expectState(move(step, body(8, 32 + positionQuantum, 120)), 8, 38 + positionQuantum, 0, 180)
  expectState(move(step, body(8, 32), 0, true), 8, 14, 0, -540)
})

test('loses support on the edge and allows a jump with support at tick start', () => {
  const step = createPhysicsStepper(world(solid(0, 96, 8, 4)), balance)
  const standing = move(step, body(8 - positionQuantum, 48))
  expectState(standing, 8 - positionQuantum, 48, 0, 0, true)
  const walkedOff = move(step, standing.body, 120)
  expectState(walkedOff, 12 - positionQuantum, 50, 120, 60)
  expectState(move(step, walkedOff.body, 120, true), 16 - positionQuantum, 54, 120, 120)
  expectState(move(step, body(4, 48), 120, true), 8, 30, 120, -540)
  expectState(move(step, body(4, 48), 120), 8, 50, 120, 60)
})

test('falls through an exact-fit gap and resolves corner contact in X-then-Y order', () => {
  const gap = createPhysicsStepper(world(solid(-64, 80, 64, 4), oneWay(24, 80, 64, 4)), balance)
  expectState(move(gap, body(0, 30, 120)), 0, 36, 0, 180)

  const corner = createPhysicsStepper(world(solid(32, 64, 48, 16)), balance)
  expectState(move(corner, body(0, 16), 360), 12, 16, 360, 0, true)
  expectState(move(corner, body(0, 16), 240), 8, 18, 240, 60)
  expectState(move(corner, body(0, 17), 360), 8, 19, 0, 60)
})

test('resolves the nearest eligible face with reversed input order and coincident surfaces', () => {
  const colliders = [
    solid(60, -16, 1, 80),
    solid(32, -16, 1, 80),
    solid(-192, 88, 160, 4),
    oneWay(-192, 80, 160, 1),
    solid(-192, 80, 160, 1),
  ]
  for (const order of [colliders, colliders.toReversed(), [colliders[2], colliders[4], colliders[0], colliders[3], colliders[1]]]) {
    const step = createPhysicsStepper(world(...order), balance)
    expectState(move(step, body(0, 0), 3000), 8, 2, 0, 60)
    expectState(move(step, body(100, 0), -3000), 61, 2, 0, 60)
    expectState(move(step, body(-100, 12, 900)), -100, 32, 0, 0, true)
  }
})

test('clamps left, right and top bounds and reports the open bottom at the void plane', () => {
  const step = createPhysicsStepper(world(), balance)
  expectState(move(step, body(-250, -250, -900), -900), -256, -256, 0, 0)
  expectState(move(step, body(480, 0), 240), 488, 2, 0, 60)
  expectState(move(step, body(480, 0), maxPhysicsSpeed), 488, 2, 0, 60)
  expectState(move(step, body(0, 480)), 0, 482, 0, 60)
  expectState(move(step, body(0, 526 - positionQuantum)), 0, 528 - positionQuantum, 0, 60)
  expectState(move(step, body(0, 526)), 0, 528, 0, 60, false, true)
  expectState(move(step, body(0, 526, 900)), 0, 556, 0, 900, false, true)
})

test('snapshots geometry and configuration and leaves the input body untouched', () => {
  const floor = solid(-64, 96, 128, 6)
  const definition = world(floor)
  const config = { ...balance }
  const step = createPhysicsStepper(definition, config)
  floor.bounds.origin.y = 200
  definition.colliders.length = 0
  definition.bounds.origin.x = 100
  config.gravityUnitsPerSecondSquared = 0
  const initial = body(0, 47)
  Object.freeze(initial.bounds.origin)
  Object.freeze(initial.bounds)
  Object.freeze(initial.velocity)
  Object.freeze(initial)
  expectState(move(step, initial), 0, 48, 0, 0, true)
  expect(initial).toEqual(body(0, 47))
})

test.each([
  [world(solid(0, 64, 0, 1)), 'INVALID_GEOMETRY'],
  [world(solid(0, 64, 32, positionQuantum / 2)), 'INVALID_GEOMETRY'],
  [world(solid(0.001, 64, 32, 1)), 'INVALID_GEOMETRY'],
  [world(solid('0', 64, 32, 1)), 'INVALID_GEOMETRY'],
  [world(solid(0, 64, 32n, 1)), 'INVALID_GEOMETRY'],
  [world(solid(0, NaN, 32, 1)), 'INVALID_GEOMETRY'],
  [world({ kind: 'slope', bounds: box(0, 64, 32, 1) }), 'INVALID_GEOMETRY'],
  [world(solid(512, 64, 32, 1)), 'OUT_OF_BOUNDS'],
  [{ ...world(), voidDepthWorldUnits: -1 }, 'INVALID_GEOMETRY'],
  [{ ...world(), voidDepthWorldUnits: maxWorldCoordinate }, 'INVALID_GEOMETRY'],
])('rejects malformed or unsupported world geometry %#', (definition, code) => {
  expect(() => createPhysicsStepper(definition, balance)).toThrow(expect.objectContaining({ code }))
})

test('rejects invalid config, motion, variable delta and starting penetration', () => {
  for (const config of [
    { ...balance, gravityUnitsPerSecondSquared: -1 },
    { ...balance, jumpSpeedUnitsPerSecond: Infinity },
    { ...balance, terminalFallSpeedUnitsPerSecond: 0 },
  ]) {
    expect(() => createPhysicsStepper(world(), config)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }))
  }

  const step = createPhysicsStepper(world(solid(0, 80, 64, 4)), balance)
  const airborne = body(0, 0)
  for (const dt of [0, 1 / 60, 1 / 15, NaN, Infinity]) {
    expect(() => step(airborne, { horizontalSpeedUnitsPerSecond: 0, jumpPressed: false }, dt)).toThrow(
      expect.objectContaining({ code: 'INVALID_TIMESTEP' })
    )
  }
  for (const attempt of [
    () => move(step, airborne, maxPhysicsSpeed + 1),
    () => move(step, airborne, NaN),
    () => move(step, airborne, 0, 'true'),
    () => move(step, body(0, 0, -Infinity)),
  ]) {
    expect(attempt).toThrow(expect.objectContaining({ code: 'INVALID_MOTION' }))
  }
  expect(() => move(step, body(maxWorldCoordinate, 0))).toThrow(expect.objectContaining({ code: 'INVALID_GEOMETRY' }))
  expect(() => move(step, body(-257, 0))).toThrow(expect.objectContaining({ code: 'OUT_OF_BOUNDS' }))
  expect(() => move(step, body(0, 33))).toThrow(expect.objectContaining({ code: 'INITIAL_OVERLAP' }))
  expect(() => move(step, body(0, maxWorldCoordinate - 48))).toThrow(expect.objectContaining({ code: 'OUT_OF_BOUNDS' }))
})
