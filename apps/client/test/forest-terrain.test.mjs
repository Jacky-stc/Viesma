import { createInitialGameDataSource, loadGameData, loadGrayboxGameData } from '@viesma/game-data'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { BufferImageSource, Texture } from 'pixi.js'
import { expect, test, vi } from 'vitest'
import slices from '../src/rendering/forest-organic-terrain-slices.json' with { type: 'json' }
import { createForestTerrainView, forestOrganicTerrainCells, forestTerrainCells } from '../src/rendering/forest-terrain.ts'
import { loadProjectAssets } from '../tools/asset-project.ts'

const map = loadGrayboxGameData().tiledMaps.find(({ id }) => id === 'm1')

function occupiedUnits(rectangles) {
  const cells = new Set()
  for (const { x, y, width, height } of rectangles) {
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) {
        const id = row * map.bounds.width + column
        if (cells.has(id)) throw new Error('Terrain pieces overlap')
        cells.add(id)
      }
    }
  }
  return cells
}

test('forest tiles cover the exact imported colliders including off-grid ledges and the unfilled gap', () => {
  const cells = forestTerrainCells(map)
  const colliders = map.colliders.map(({ bounds }) => ({ ...bounds.origin, width: bounds.width, height: bounds.height }))
  expect(occupiedUnits(cells)).toEqual(occupiedUnits(colliders))
  expect(cells).toContainEqual({ id: 'forest-ground-left', x: 1432, y: 896, width: 32, height: 32 })
  expect(cells).toContainEqual({ id: 'forest-platform-left', x: 1280, y: 824, width: 32, height: 12 })
  expect(cells).toContainEqual({ id: 'forest-platform-right', x: 1368, y: 824, width: 32, height: 12 })
  expect(cells).toContainEqual({ id: 'forest-ground-right', x: 834, y: 816, width: 32, height: 24 })
  expect(cells.some(({ x, y }) => x >= 1248 && x < 1432 && y >= 896)).toBe(false)
})

test('the 32px Tiled tileset imports through the existing parser and its grid matches the experimental atlas', () => {
  const key = 'forest-terrain.tsj'
  const rawMap = JSON.parse(readFileSync(new URL('../../../packages/game-data/src/maps/m1.json', import.meta.url), 'utf8'))
  const tileset = JSON.parse(readFileSync(new URL('../../../content/assets/images/forest-terrain.tsj', import.meta.url), 'utf8'))
  const catalog = loadProjectAssets(false, true).catalog
  const atlas = catalog.atlases.find(({ id }) => id === 'forest-terrain-atlas')
  expect(loadProjectAssets().catalog.atlases.some(({ id }) => id === atlas.id)).toBe(false)
  const image = readFileSync(new URL('../../../content/assets/images/forest-terrain-atlas.png', import.meta.url))
  expect(loadProjectAssets(false, true).files.get(atlas.output)).toEqual(image)
  const data = Array(map.widthTiles * map.heightTiles).fill(0)
  data[0] = tileset.tilecount
  const rawVisualMap = {
    ...rawMap,
    tilesets: [{ source: key, firstgid: 1 }],
    layers: [
      ...rawMap.layers,
      {
        id: 6,
        type: 'tilelayer',
        name: 'Visual sample',
        x: 0,
        y: 0,
        width: map.widthTiles,
        height: map.heightTiles,
        visible: true,
        opacity: 1,
        data,
      },
    ],
    nextlayerid: 7,
  }
  const [imported] = loadGameData(createInitialGameDataSource(), [
    { mapId: 'm1', map: rawVisualMap, tilesets: { [key]: tileset } },
  ]).tiledMaps
  expect(imported.tileLayers[0].cells[0]).toMatchObject({ tileset: key, tileId: 8 })
  expect(imported.tilesets[0]).toMatchObject({ margin: 2, spacing: 4, imageWidth: atlas.width, imageHeight: atlas.height })
  const { tilesets: importedTilesets, tileLayers: importedLayers, ...importedGeometry } = imported
  const { tilesets: baselineTilesets, tileLayers: baselineLayers, ...baselineGeometry } = map
  expect([importedTilesets.length, importedLayers.length, baselineTilesets.length, baselineLayers.length]).toEqual([1, 1, 0, 0])
  expect(importedGeometry).toEqual(baselineGeometry)
  expect(atlas.sprites.map(({ clips }) => clips.idle.frames[0]).sort((a, b) => a.y - b.y || a.x - b.x)).toEqual(
    Array.from({ length: tileset.tilecount }, (_, i) => ({
      x: 2 + (i % 3) * 36,
      y: 2 + Math.floor(i / 3) * 36,
      width: 32,
      height: 32,
    }))
  )
})

test('atlas fallback, clipped subframes and display objects have a single scene lifetime', () => {
  const source = new BufferImageSource({ resource: new Uint8Array(32 * 32 * 4), width: 32, height: 32 })
  const texture = new Texture({ source })
  const assets = { prepare: vi.fn(), resolve: vi.fn(), destroy: vi.fn(() => texture.destroy(true)) }
  const terrain = createForestTerrainView(map, assets)
  expect(terrain.prepare()).toBe(false)
  expect(terrain.stats()).toEqual({ cells: 0, decodedBytes: 0 })
  assets.resolve.mockReturnValue({ texture, width: 32, height: 32 })
  expect(terrain.prepare()).toBe(true)
  expect(terrain.prepare()).toBe(true)
  const views = [...terrain.root.children]
  const platform = views.find(({ x, y }) => x === 1280 && y === 824)
  const crop = platform.texture
  expect(crop.height).toBe(12)
  expect(crop.source).toBe(source)
  expect(terrain.stats()).toEqual({ cells: forestTerrainCells(map).length, decodedBytes: 4096 })
  terrain.destroy()
  expect(views.every(({ destroyed }) => destroyed)).toBe(true)
  expect(crop.destroyed).toBe(true)
  expect(assets.destroy).toHaveBeenCalledOnce()
})

test('organic caps and complete repeats align to all seven collision surfaces with an open ground gap', () => {
  expect(map.colliders.map(({ bounds, kind }) => [bounds.origin.x, bounds.origin.y, bounds.width, bounds.height, kind])).toEqual([
    [384, 824, 168, 12, 'oneWay'],
    [2152, 744, 248, 12, 'oneWay'],
    [1280, 824, 120, 12, 'oneWay'],
    [0, 896, 1248, 128, 'solid'],
    [1432, 896, 2664, 128, 'solid'],
    [640, 816, 226, 24, 'solid'],
    [1920, 816, 256, 24, 'solid'],
  ])
  const cells = forestOrganicTerrainCells(map)
  const atlas = loadProjectAssets(false, true).catalog.atlases.find(({ id }) => id === 'forest-organic-terrain-atlas')
  expect(atlas.sprites).toHaveLength(9)
  let next = 0
  for (const [{ bounds }, family, count] of map.colliders.map((collider, index) => [
    collider,
    ['thin', 'thin', 'thin', 'ground', 'ground', 'thick', 'thick'][index],
    [3, 4, 2, 4, 7, 3, 3][index],
  ])) {
    const pieces = cells.slice(next, next + count)
    next += count
    expect(pieces[0].x).toBe(bounds.origin.x)
    expect(pieces.at(-1).x + pieces.at(-1).width).toBeCloseTo(bounds.origin.x + bounds.width)
    for (const [index, cell] of pieces.entries()) {
      const side = index === 0 ? 'left' : index === count - 1 ? 'right' : 'middle'
      const { region, surfaceY } = slices[family][side]
      const id = `forest-organic-${family}-${side}`
      const [frame] = atlas.sprites.find((sprite) => sprite.id === id).clips.idle.frames
      expect(cell.id).toBe(id)
      expect(cell.y + ((surfaceY - region.y0) * cell.height) / (region.y1 - region.y0)).toBeCloseTo(bounds.origin.y)
      expect(frame.width * 2).toBe(region.x1 - region.x0)
      expect(frame.height * 2).toBe(region.y1 - region.y0)
      if (index > 0) expect(cell.x).toBeCloseTo(pieces[index - 1].x + pieces[index - 1].width)
      if (side !== 'middle') expect(cell.width / cell.height).toBeCloseTo(frame.width / frame.height)
    }
  }
  expect(cells).toHaveLength(next)
  expect(loadProjectAssets().catalog.atlases.some(({ id }) => id === atlas.id)).toBe(false)
  expect(forestOrganicTerrainCells({ ...map, id: 'm2' })).toEqual([])
})

test('a platform narrower than both caps keeps the whole image and scales the caps uniformly', () => {
  const original = map.colliders.find(({ id }) => id === 'forest_crossing')
  const width = 43
  const [left, right] = forestOrganicTerrainCells({ ...map, colliders: [{ ...original, bounds: { ...original.bounds, width } }] })
  expect(left.id).toBe('forest-organic-thin-left')
  expect(right.id).toBe('forest-organic-thin-right')
  expect(left.width + right.width).toBeCloseTo(width)
  expect(left.width / 450).toBeCloseTo(left.height / 358, 8)
  expect(right.width / 416).toBeCloseTo(right.height / 288, 8)
})

test('the four organic source images retain their reviewed SHA-256', () => {
  const root = new URL('../../../art/source/environments/forest-entrance/organic-terrain/', import.meta.url)
  for (const [name, digest] of Object.entries(slices.sources)) {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL(`${name}.png`, root)))
        .digest('hex')
    ).toBe(digest)
  }
})
