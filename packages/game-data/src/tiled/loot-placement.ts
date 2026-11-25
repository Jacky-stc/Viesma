import { fixedDeltaSeconds, type WorldPoint } from '@viesma/domain'
import {
  createPhysicsStepper,
  createSolidObstructionTest,
  isGridCoordinate,
  PhysicsValidationError,
  positionQuantum,
} from '@viesma/physics'
import { initialEncounterRewardBalance } from '../encounter-rewards.js'
import { initialPhysicsBalance } from '../initial-physics.js'
import { playerBody } from './objects.js'
import type { NormalizedMap } from './types.js'

const halfWidth = initialPhysicsBalance.bodyWidthWorldUnits / 2
const height = initialPhysicsBalance.bodyHeightWorldUnits
const radius = initialEncounterRewardBalance.lootPlacementRadiusWorldUnits

export function createLootPlacement(map: NormalizedMap) {
  const step = createPhysicsStepper(map, initialPhysicsBalance)
  const obstructed = createSolidObstructionTest(map.colliders)
  const { origin, width, height: mapHeight } = map.bounds
  const right = origin.x + width
  const bottom = origin.y + mapHeight
  const inside = ({ x, y }: WorldPoint) =>
    isGridCoordinate(x) && isGridCoordinate(y) && x >= origin.x && x <= right && y >= origin.y && y < bottom
  const solids = map.colliders.filter(({ kind }) => kind === 'solid')
  const floors = map.colliders.map(({ bounds }) => ({ min: bounds.origin.x, max: bounds.origin.x + bounds.width, y: bounds.origin.y }))

  function safe(point: WorldPoint): boolean {
    const { x, y } = point
    if (!inside(point) || !floors.some((floor) => floor.y === y && floor.min < x && x < floor.max)) return false
    const bounds = playerBody({ x: x - halfWidth, y: y - height })
    if (
      map.colliders.some(
        ({ kind, bounds: surface }) =>
          kind === 'oneWay' &&
          surface.origin.y > bounds.origin.y &&
          surface.origin.y < y &&
          bounds.origin.x < surface.origin.x + surface.width &&
          x + halfWidth > surface.origin.x
      )
    )
      return false
    try {
      const resting = step(
        { bounds, velocity: { x: 0, y: 0 } },
        { horizontalSpeedUnitsPerSecond: 0, jumpPressed: false },
        fixedDeltaSeconds
      )
      return resting.grounded && !resting.inVoid && resting.body.bounds.origin.y === bounds.origin.y
    } catch (error) {
      if (!(error instanceof PhysicsValidationError)) throw error
      return false
    }
  }

  const byId = <T extends { readonly id: string }>(points: readonly T[]) =>
    [...points].sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)))
  const playerSpawns = byId(map.spawns).sort((a, b) => Number(b.id === 'spawn_from_village') - Number(a.id === 'spawn_from_village'))
  const fallback = map.lootFallbacks.length
    ? byId(map.lootFallbacks)
        .map(({ position }) => position)
        .find(safe)
    : playerSpawns.map(({ position }) => ({ x: position.x + halfWidth, y: position.y + height })).find(safe)
  const boundaries = map.colliders.flatMap(({ kind, bounds }) => {
    const { x } = bounds.origin
    const end = x + bounds.width
    return [x - halfWidth, end + halfWidth, ...(kind === 'solid' ? [x, end] : [])]
  })

  return {
    safe,
    fallback,
    place(death: WorldPoint): WorldPoint {
      if (inside(death)) {
        const candidates = floors.flatMap(({ min, max, y }) => {
          const left = Math.max(min + positionQuantum, origin.x + halfWidth, death.x - radius)
          const rightEdge = Math.min(max - positionQuantum, right - halfWidth, death.x + radius)
          if (y < death.y || left > rightEdge) return []
          // 在碰撞邊界與角色淨空改變的座標取樣，避免逐個掃描 1/1024 單位。
          const xs = new Set([Math.max(left, Math.min(death.x, rightEdge)), left, rightEdge, ...boundaries])
          return [...xs].filter((x) => left <= x && x <= rightEdge).map((x) => ({ x, y }))
        })
        candidates.sort((a, b) => a.y - b.y || Math.abs(a.x - death.x) - Math.abs(b.x - death.x) || a.x - b.x)
        const found = candidates.find((point) => {
          const above = { x: point.x, y: death.y }
          return (
            !obstructed(death, above) &&
            !obstructed(above, point) &&
            !solids.some(
              ({ bounds }) =>
                bounds.origin.x < point.x &&
                point.x < bounds.origin.x + bounds.width &&
                bounds.origin.y < point.y &&
                point.y < bounds.origin.y + bounds.height
            ) &&
            safe(point)
          )
        })
        if (found) return found
      }
      if (!fallback) throw new RangeError('Missing validated loot fallback')
      return fallback
    },
  }
}
