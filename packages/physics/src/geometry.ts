import type { WorldPoint } from '@viesma/domain'
import { PhysicsValidationError } from './errors.js'

export const positionQuantum = 1 / 1024
export const maxWorldCoordinate = 2 ** 20

/** origin 是左上角，寬高使用 world units。 */
export interface Aabb {
  readonly origin: WorldPoint
  readonly width: number
  readonly height: number
}

export interface PlatformCollider {
  readonly bounds: Aabb
  readonly kind: 'solid' | 'oneWay'
}

export interface Edges {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface Collider extends Edges {
  readonly kind: PlatformCollider['kind']
}

export function isGridCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= maxWorldCoordinate && Number.isInteger(value / positionQuantum)
}

export function readEdges(bounds: Aabb, path: string): Edges {
  const left = bounds?.origin?.x
  const top = bounds?.origin?.y
  const width = bounds?.width
  const height = bounds?.height
  if (
    !isGridCoordinate(left) ||
    !isGridCoordinate(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isInteger(width / positionQuantum) ||
    !Number.isInteger(height / positionQuantum) ||
    width < positionQuantum ||
    height < positionQuantum
  ) {
    throw new PhysicsValidationError('INVALID_GEOMETRY', `${path} requires positive dimensions and supported grid coordinates`)
  }
  const right = left + width
  const bottom = top + height
  if (!isGridCoordinate(right) || !isGridCoordinate(bottom)) {
    throw new PhysicsValidationError('INVALID_GEOMETRY', `${path} edges exceed the supported coordinate range`)
  }
  return { left, top, right, bottom }
}

export function prepareColliders(inputs: readonly PlatformCollider[], world: Edges): Collider[] {
  if (!Array.isArray(inputs)) {
    throw new PhysicsValidationError('INVALID_GEOMETRY', 'World colliders must be an array')
  }
  const colliders = Array.from(inputs, (input: PlatformCollider, index) => {
    if (input?.kind !== 'solid' && input?.kind !== 'oneWay') {
      throw new PhysicsValidationError('INVALID_GEOMETRY', `colliders[${index}] has an unsupported kind`)
    }
    const edges = readEdges(input.bounds, `colliders[${index}].bounds`)
    if (edges.left < world.left || edges.right > world.right || edges.top < world.top || edges.bottom > world.bottom) {
      throw new PhysicsValidationError('OUT_OF_BOUNDS', `colliders[${index}] must fit within the world bounds`)
    }
    return { ...edges, kind: input.kind }
  })
  return colliders.sort(
    (a, b) =>
      a.left - b.left ||
      a.top - b.top ||
      a.right - b.right ||
      a.bottom - b.bottom ||
      Number(a.kind === 'oneWay') - Number(b.kind === 'oneWay')
  )
}

export function quantizePosition(value: number): number {
  return Math.round(value / positionQuantum) * positionQuantum || 0
}

export function overlaps(min: number, max: number, otherMin: number, otherMax: number): boolean {
  return min < otherMax && max > otherMin
}

export function crossesFace(start: number, target: number, face: number, positive: boolean): boolean {
  return positive ? start <= face && face <= target : target <= face && face <= start
}

function axisInterval(start: number, end: number, min: number, max: number): readonly [number, number] | undefined {
  const distance = end - start
  if (distance === 0) return start > min && start < max ? [-Infinity, Infinity] : undefined
  const enter = (min - start) / distance
  const exit = (max - start) / distance
  return [Math.min(enter, exit), Math.max(enter, exit)]
}

/** 檢查直線是否穿入 AABB 內部，沿邊或只碰到角點不相交。 */
export function segmentIntersectsInterior(from: WorldPoint, to: WorldPoint, { left, top, right, bottom }: Edges): boolean {
  const horizontal = axisInterval(from.x, to.x, left, right)
  const vertical = axisInterval(from.y, to.y, top, bottom)
  return Boolean(horizontal && vertical && Math.max(0, horizontal[0], vertical[0]) < Math.min(1, horizontal[1], vertical[1]))
}
