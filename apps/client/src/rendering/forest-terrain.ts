import type { NormalizedMap } from '@viesma/game-data'
import { Container, Rectangle, Sprite, Texture } from 'pixi.js'
import type { AtlasScope } from './assets/atlas-scope'
import organicSlices from './forest-organic-terrain-slices.json' with { type: 'json' }
import { forestFloorIds } from './forest-parallax'

const ground = ['forest-ground-left', 'forest-ground-middle', 'forest-ground-right'] as const
const platform = ['forest-platform-left', 'forest-platform-middle', 'forest-platform-right'] as const
const soil = ['forest-soil', 'forest-soil', 'forest-soil'] as const
const bottom = ['forest-bottom-left', 'forest-soil', 'forest-bottom-right'] as const
const { ground: organicGround, thick, thin } = organicSlices
const organic = { ground: organicGround, thick, thin }
type TerrainTile =
  (typeof ground | typeof platform | typeof bottom)[number] | `forest-organic-${keyof typeof organic}-${'left' | 'middle' | 'right'}`
export type ForestRenderMode = 'graybox' | 'rectangular' | 'organic'

interface TerrainCell {
  readonly id: TerrainTile
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function forestTerrainCells(map: NormalizedMap) {
  const cells: TerrainCell[] = []
  if (map.id !== 'm1') return cells
  const tileSize = map.tileSizeWorldUnits
  for (const { bounds, kind } of map.colliders) {
    const { origin, width, height } = bounds
    for (let y = 0; y < height; y += tileSize) {
      const row = y === 0 ? (kind === 'oneWay' ? platform : ground) : y + tileSize >= height ? bottom : soil
      const cellHeight = Math.min(tileSize, height - y)
      const right = Math.max(tileSize, width - tileSize)
      // 末端圖塊貼齊右邊界，非整格的餘寬由中段圖塊裁切保留。
      for (let x = 0; x < width;) {
        const id = x === 0 ? row[0] : x < right ? row[1] : row[2]
        const cellWidth = Math.min(tileSize, width - x, (x < right ? right : width) - x)
        cells.push({ id, x: origin.x + x, y: origin.y + y, width: cellWidth, height: cellHeight })
        x += cellWidth
      }
    }
  }
  return cells
}

export function forestOrganicTerrainCells(map: NormalizedMap) {
  const cells: TerrainCell[] = []
  if (map.id !== 'm1') return cells
  for (const { id, kind, bounds } of map.colliders) {
    const name = kind === 'oneWay' ? 'thin' : forestFloorIds.has(id) ? 'ground' : 'thick'
    const family = organic[name]
    const scale = family.worldUnitsPerSourcePixel
    const { origin, width } = bounds
    const right = origin.x + width
    const pieceWidth = (side: 'left' | 'middle' | 'right') => {
      const { x0, x1 } = family[side].region
      return (x1 - x0) * scale
    }
    const leftWidth = pieceWidth('left')
    const rightWidth = pieceWidth('right')
    const repeatWidth = pieceWidth('middle')
    const capWidth = leftWidth + rightWidth
    const interior = width - capWidth
    // 短平台以等比縮放的端蓋直接對接。長段只調整完整中段的水平間距。
    const count = interior < repeatWidth / 2 ? 0 : Math.round(interior / repeatWidth)
    const capScale = count ? 1 : width / capWidth
    const leftJoin = origin.x + leftWidth * capScale
    const rightJoin = count ? right - rightWidth : leftJoin
    const place = (side: 'left' | 'middle' | 'right', x: number, end: number, scaleY: number) => {
      const {
        region: { y0, y1 },
        surfaceY,
      } = family[side]
      cells.push({
        id: `forest-organic-${name}-${side}`,
        x,
        y: origin.y - (surfaceY - y0) * scaleY,
        width: end - x,
        height: (y1 - y0) * scaleY,
      })
    }
    place('left', origin.x, leftJoin, scale * capScale)
    for (let index = 0; index < count; index++) {
      const x = leftJoin + (interior * index) / count
      const end = index + 1 === count ? rightJoin : leftJoin + (interior * (index + 1)) / count
      place('middle', x, end, scale)
    }
    place('right', rightJoin, right, scale * capScale)
  }
  return cells
}

export function createForestTerrainView(
  map: NormalizedMap,
  assets: AtlasScope,
  mode: Exclude<ForestRenderMode, 'graybox'> = 'rectangular'
) {
  const root = new Container()
  const cells = mode === 'organic' ? forestOrganicTerrainCells(map) : forestTerrainCells(map)
  const ids = new Set(cells.map(({ id }) => id))
  const crops = new Map<string, Texture>()
  for (const id of ids) assets.prepare(id)
  let decodedBytes = 0

  return {
    root,
    prepare() {
      if (decodedBytes > 0) return true
      const textures = new Map<TerrainTile, Texture>()
      for (const id of ids) {
        const asset = assets.resolve(id, 'idle', 0)
        if (!asset) return false
        textures.set(id, asset.texture)
      }
      const first = textures.values().next().value
      if (!first) return false
      for (const { id, x, y, width, height } of cells) {
        const full = textures.get(id)
        if (!full) continue
        let texture = full
        if (mode === 'rectangular' && (width !== map.tileSizeWorldUnits || height !== map.tileSizeWorldUnits)) {
          const key = `${id}:${width}:${height}`
          const cached = crops.get(key)
          const frame = full.frame
          texture =
            cached ??
            new Texture({
              source: full.source,
              frame: new Rectangle(
                frame.x,
                frame.y,
                (width * frame.width) / map.tileSizeWorldUnits,
                (height * frame.height) / map.tileSizeWorldUnits
              ),
            })
          if (!cached) crops.set(key, texture)
        }
        const sprite = new Sprite(texture)
        sprite.position.set(x, y)
        sprite.setSize(width, height)
        root.addChild(sprite)
      }
      decodedBytes = first.source.pixelWidth * first.source.pixelHeight * 4
      return true
    },
    stats() {
      return { decodedBytes, cells: root.children.length }
    },
    destroy() {
      root.destroy({ children: true })
      for (const texture of crops.values()) texture.destroy()
      assets.destroy()
    },
  }
}
