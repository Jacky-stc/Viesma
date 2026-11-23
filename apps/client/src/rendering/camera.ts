import type { WorldPoint } from '@viesma/domain'
import type { Aabb } from '@viesma/physics'

export interface ViewportSize {
  readonly width: number
  readonly height: number
}

export interface CameraView {
  readonly origin: WorldPoint
  readonly scale: number
}

function followAxis(target: number, worldStart: number, worldLength: number, visibleLength: number): number {
  if (worldLength <= visibleLength) return worldStart + (worldLength - visibleLength) / 2
  return Math.max(worldStart, Math.min(target - visibleLength / 2, worldStart + worldLength - visibleLength))
}

export function followCamera(target: WorldPoint, bounds: Aabb, viewport: ViewportSize): CameraView {
  const scale = Math.min(viewport.width / 1280, viewport.height / 720)
  return {
    scale,
    origin: {
      x: followAxis(target.x, bounds.origin.x, bounds.width, viewport.width / scale),
      y: followAxis(target.y, bounds.origin.y, bounds.height, viewport.height / scale),
    },
  }
}
