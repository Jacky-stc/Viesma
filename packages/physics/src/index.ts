import type { WorldPoint } from '@viesma/domain'

export type { WorldPoint } from '@viesma/domain'

/** 世界座標中的軸對齊矩形，寬高使用 world units。 */
export interface Aabb {
  readonly origin: WorldPoint
  readonly width: number
  readonly height: number
}

export interface PlatformCollider {
  readonly bounds: Aabb
  readonly kind: 'solid' | 'oneWay'
}
