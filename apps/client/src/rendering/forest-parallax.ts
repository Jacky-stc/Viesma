import type { NormalizedMap } from '@viesma/game-data'
import type { ParallaxLayer } from './parallax-layout'

const background = { plane: 'background', factorY: 1, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, repeatX: true, visible: true } as const

export const forestParallax: readonly ParallaxLayer[] = [
  { ...background, assetId: 'forest-sky', order: 0, placement: 'viewport-cover', factorX: 0, factorY: 0, repeatX: false },
  { ...background, assetId: 'forest-ruins', order: 10, placement: 'map-bottom', factorX: 0.1, offsetX: -380, offsetY: -195 },
  { ...background, assetId: 'forest-far-trees', order: 20, placement: 'map-bottom', factorX: 0.3, offsetX: -300, offsetY: -115 },
  { ...background, assetId: 'forest-near-trees', order: 30, placement: 'map-bottom', factorX: 0.6, offsetX: -160, offsetY: -25 },
  {
    ...background,
    assetId: 'forest-foreground',
    plane: 'foreground',
    order: 50,
    placement: 'ground-band',
    factorX: 1.1,
    scale: 0.72,
    offsetX: -220,
    offsetY: 80,
    opacity: 0.64,
  },
]

export const experimentalMapParallax: ReadonlyMap<string, readonly ParallaxLayer[]> = new Map([['m1', forestParallax]])

export const organicForestParallax = forestParallax.filter(({ plane }) => plane === 'background')
export const forestFloorIds: ReadonlySet<string> = new Set(['forest_entrance_ground', 'forest_far_ground'])

export function forestForegroundBands(map: NormalizedMap) {
  if (map.id !== 'm1') return undefined
  const inset = map.tileSizeWorldUnits
  return map.colliders
    .filter(({ id, kind, bounds }) => kind === 'solid' && forestFloorIds.has(id) && bounds.height > inset)
    .map(({ bounds }) => ({
      origin: { x: bounds.origin.x, y: bounds.origin.y + inset },
      width: bounds.width,
      height: bounds.height - inset,
    }))
}
