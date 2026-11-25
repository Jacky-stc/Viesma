import type { WorldPoint } from '@viesma/domain'
import { crossesFace, quantizePosition, readEdges, segmentIntersectsInterior, type Edges, type PlatformCollider } from './geometry.js'

export type SolidPointSweep = (from: WorldPoint, to: WorldPoint) => WorldPoint
export type SolidObstructionTest = (from: WorldPoint, to: WorldPoint) => boolean

function readSolidEdges(colliders: readonly PlatformCollider[]): Edges[] {
  return colliders.flatMap(({ kind, bounds }, index) => (kind === 'solid' ? [readEdges(bounds, `colliders[${index}].bounds`)] : []))
}

export function createSolidObstructionTest(colliders: readonly PlatformCollider[]): SolidObstructionTest {
  const solids = readSolidEdges(colliders)
  return (from, to) => solids.some((solid) => segmentIntersectsInterior(from, to, solid))
}

function sweepAxis(from: number, to: number, across: number, solids: readonly Edges[], axis: 'x' | 'y'): number {
  let position = quantizePosition(to)
  if (position === from) return from
  const positive = position > from
  for (const { left, right, top, bottom } of solids) {
    const [min, max, otherMin, otherMax] = axis === 'x' ? [left, right, top, bottom] : [top, bottom, left, right]
    if (otherMin < across && across < otherMax) {
      const face = positive ? min : max
      if (crossesFace(from, position, face, positive)) position = face
    }
  }
  return position
}

/** 怪物的移動錨點沿面滑動，觸及邊界不算進入 solid。 */
export function createSolidPointSweep(colliders: readonly PlatformCollider[]): SolidPointSweep {
  const solids = readSolidEdges(colliders)
  return (from, to) => {
    const x = sweepAxis(from.x, to.x, from.y, solids, 'x')
    const y = sweepAxis(from.y, to.y, x, solids, 'y')
    return { x, y }
  }
}
