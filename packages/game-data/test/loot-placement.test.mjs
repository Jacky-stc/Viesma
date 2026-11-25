import { createLootPlacement, loadGrayboxGameData } from '@viesma/game-data'
import { positionQuantum } from '@viesma/physics'
import { expect, test } from 'vitest'

const maps = loadGrayboxGameData().tiledMaps
const floor = (x, y, width, height = 12, kind = 'solid') => ({ kind, bounds: { origin: { x, y }, width, height } })
const fallback = { x: 400, y: 300 }
function geometry(...colliders) {
  return {
    bounds: { origin: { x: 0, y: 0 }, width: 500, height: 400 },
    voidDepthWorldUnits: 128,
    colliders: [...colliders, floor(300, 300, 200, 100)],
    spawns: [],
    lootFallbacks: [{ id: 'fallback', position: fallback }],
  }
}

test('keeps a grounded death anchor on the floor and chooses the closest safe x within 24 units', () => {
  const placement = createLootPlacement(geometry(floor(90, 220, 110)))
  expect(placement.place({ x: 120, y: 220 })).toEqual({ x: 120, y: 220 })
  expect(placement.place({ x: 70, y: 220 })).toEqual({ x: 90 + positionQuantum, y: 220 })
  expect(placement.place({ x: 66 + positionQuantum, y: 220 }).x - (66 + positionQuantum)).toBe(24)
  expect(placement.place({ x: 66, y: 220 })).toEqual(fallback)
})

test('projects airborne loot downward to the highest accessible one-way or solid floor', () => {
  const placement = createLootPlacement(geometry(floor(28, 140, 90, 12, 'oneWay'), floor(0, 250, 220)))
  expect(placement.place({ x: 70, y: 82 })).toEqual({ x: 70, y: 140 })
  expect(placement.place({ x: 70, y: 160 })).toEqual({ x: 70, y: 250 })
  const map = maps.find(({ id }) => id === 'm2')
  const bat = map.monsterSpawns.find(({ movement }) => movement === 'flight')
  const actual = createLootPlacement(map).place(bat.position)
  expect(actual.y).toBeGreaterThan(bat.position.y)
  expect(Math.abs(actual.x - bat.position.x)).toBeLessThanOrEqual(24)
  expect(createLootPlacement(map).safe(actual)).toBe(true)
})

test('requires character clearance, world bounds and an unobstructed projection', () => {
  const placement = createLootPlacement(geometry(floor(20, 200, 180), floor(20, 150, 180, 40)))
  expect(placement.safe({ x: 100, y: 200 })).toBe(false)
  expect(placement.place({ x: 100, y: 110 })).toEqual({ x: 100, y: 150 })
  expect(placement.place({ x: 100, y: 160 })).toEqual(fallback)
  expect(placement.place({ x: -1, y: 150 })).toEqual(fallback)
  expect(placement.place({ x: 100, y: 400 })).toEqual(fallback)
  expect(placement.place({ x: Infinity, y: 150 })).toEqual(fallback)
  expect(placement.safe({ x: 495, y: 300 })).toBe(false)
})

test('rejects malformed collider geometry and fails closed if a fallback contract is missing', () => {
  expect(() => createLootPlacement(geometry(floor(490, 220, 20)))).toThrow(/world bounds/)
  expect(() => createLootPlacement(geometry(floor(200, 220, 0)))).toThrow(/dimensions/)
  const broken = createLootPlacement({ ...geometry(), lootFallbacks: [{ id: 'invalid', position: { x: 400, y: 301 } }] })
  expect(() => broken.place({ x: 10, y: 250 })).toThrow(/Missing validated loot fallback/)
})

test('uses the validated Village-entry spawn feet as the ground-only M1 fallback', () => {
  const m1 = maps.find(({ id }) => id === 'm1')
  const placement = createLootPlacement(m1)
  expect(placement.place({ x: -50, y: 5 })).toEqual({ x: 320, y: 896 })
  expect(placement.safe(placement.fallback)).toBe(true)
})
