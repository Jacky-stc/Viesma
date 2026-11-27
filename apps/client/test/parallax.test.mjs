import { loadGrayboxGameData } from '@viesma/game-data'
import { BufferImageSource, Sprite, TilingSprite } from 'pixi.js'
import { describe, expect, test, vi } from 'vitest'
import { experimentalMapParallax, forestForegroundBands, forestParallax } from '../src/rendering/forest-parallax.ts'
import { positionGroundParallax, positionParallax } from '../src/rendering/parallax-layout.ts'
import { createParallaxRenderer } from '../src/rendering/parallax-renderer.ts'
import { loadProjectAssets } from '../tools/asset-project.ts'

const [sky, ruins, far, near, foreground] = forestParallax
const mapBottomForeground = { ...foreground, placement: 'map-bottom' }
const bounds = { origin: { x: -80, y: -40 }, width: 1000, height: 800 }
const camera = { origin: { x: -105, y: 20 }, scale: 2 }
const viewport = { width: 310, height: 240 }
const imageSize = { width: 100, height: 50 }
const assets = forestParallax.map(({ assetId }) => ({ id: assetId, ...imageSize, output: `game-assets/${assetId}.png` }))

function imageResource() {
  const source = new BufferImageSource({ resource: new Uint8Array(imageSize.width * imageSize.height * 4), ...imageSize })
  return { source, destroy: vi.fn(() => source.destroy()) }
}

describe('parallax placement', () => {
  test('relative camera factors and offsets apply before scaling, including negative origins', () => {
    const layer = { ...far, factorX: 0.3, factorY: 0.5, scale: 1.25, offsetX: 10, offsetY: -15, repeatX: false }
    expect(positionParallax(layer, imageSize, bounds, camera, viewport)).toMatchObject({ x: 35, y: 1385, width: 250, height: 125 })
  })

  test('sky covers the viewport at arbitrary offsets, aspect ratios and zoom without distortion', () => {
    const layer = { ...sky, factorX: 1, factorY: 1, offsetX: 700, offsetY: -500 }
    for (const size of [viewport, { width: 581, height: 170 }, { width: 190, height: 480 }]) {
      for (const scale of [0.25, 1, 8]) {
        const { x, y, width, height } = positionParallax(layer, imageSize, bounds, { ...camera, scale }, size)
        expect(x).toBeLessThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(0)
        expect(x + width).toBeGreaterThanOrEqual(size.width)
        expect(y + height).toBeGreaterThanOrEqual(size.height)
        expect(width / height).toBeCloseTo(imageSize.width / imageSize.height)
      }
    }
  })

  test('a horizontal repeat covers the full width with positive modulo and a single image height', () => {
    const layer = { ...near, offsetX: -15, factorX: 1 }
    const origin = { x: 10, y: 20 }
    const laidOut = positionParallax(layer, imageSize, bounds, { ...camera, origin }, viewport)
    expect(laidOut).toMatchObject({ x: 0, width: 310, height: 100, phaseX: 190 })
    const movedOneTile = { x: origin.x + imageSize.width, y: origin.y }
    expect(positionParallax(layer, imageSize, bounds, { ...camera, origin: movedOneTile }, viewport)).toEqual(laidOut)
  })

  test('ground foreground stays inside support spans across camera coordinates, zoom and extreme layer offsets', () => {
    const map = loadGrayboxGameData().tiledMaps.find(({ id }) => id === 'm1')
    const bands = forestForegroundBands(map)
    expect(bands).toEqual([
      { origin: { x: 0, y: 928 }, width: 1248, height: 96 },
      { origin: { x: 1432, y: 928 }, width: 2664, height: 96 },
    ])
    const image = { width: 2172, height: 724 }
    const size = { width: 1280, height: 720 }
    for (const scale of [0.5, 1, 1.25, 3]) {
      for (const origin of [
        { x: -50, y: 350 },
        { x: 900, y: 450 },
        { x: 1300, y: 870 },
        { x: 3000, y: 980 },
      ]) {
        for (const layer of [foreground, { ...foreground, factorY: -1, offsetY: 600 }, { ...foreground, repeatX: false }]) {
          for (const band of bands) {
            const result = positionGroundParallax(layer, image, map.bounds, band, { scale, origin }, size)
            if (!result) continue
            expect(result.x).toBeGreaterThanOrEqual(Math.max(0, (band.origin.x - origin.x) * scale))
            expect(result.y).toBeGreaterThanOrEqual(Math.max(0, (band.origin.y - origin.y) * scale))
            expect(result.x + result.width).toBeLessThanOrEqual(Math.min(size.width, (band.origin.x + band.width - origin.x) * scale))
            expect(result.y + result.height).toBeLessThanOrEqual(Math.min(size.height, (1024 - origin.y) * scale))
            expect(result.phaseY).toBeLessThanOrEqual(0)
            expect(result.height - result.phaseY).toBeLessThanOrEqual(image.height * result.scale + 1e-8)
          }
        }
      }
    }
    const gapCamera = { origin: { x: 940, y: 420 }, scale: 1 }
    const [west, east] = bands.map((band) => positionGroundParallax(foreground, image, map.bounds, band, gapCamera, size))
    expect(west.x + west.width).toBe(1248 - gapCamera.origin.x)
    expect(east.x).toBe(1432 - gapCamera.origin.x)
    expect(
      positionGroundParallax(foreground, image, map.bounds, bands[0], { ...gapCamera, origin: { x: 950, y: 420 } }, size).phaseX
    ).not.toBe(west.phaseX)
  })
})

describe('parallax scene lifetime', () => {
  test('draws layers in order by plane, applies visibility and opacity, and resizes the tiling area', async () => {
    const load = vi.fn(async () => imageResource())
    const scene = createParallaxRenderer(assets, '/', load)
    scene.setLayers([mapBottomForeground, { ...near, visible: false }, sky, { ...ruins, opacity: 0.75 }])
    await Promise.resolve()
    expect(scene.render(bounds, camera, viewport)).toBe(true)
    const [skyView, ruinsView, nearView] = scene.background.children
    expect(skyView).toBeInstanceOf(Sprite)
    expect(ruinsView).toBeInstanceOf(TilingSprite)
    expect(ruinsView.alpha).toBe(0.75)
    expect(nearView.visible).toBe(false)
    expect(scene.foreground.children).toHaveLength(1)
    expect(scene.stats()).toEqual({ decodedBytes: 80_000, loaded: 4, displayObjects: 4, visible: 3 })
    scene.render(bounds, { ...camera, scale: 0.5 }, { width: 667, height: 375 })
    expect(ruinsView.width).toBe(667)
    expect(ruinsView.height).toBe(25)
    expect(ruinsView.tilePosition.y).toBe(0)
    scene.destroy()
  })

  test('compatible maps reuse loaded images and release all obsolete views and textures on repeated transfers', async () => {
    const load = vi.fn(async () => imageResource())
    const scene = createParallaxRenderer(assets, '/', load)
    for (let iteration = 0; iteration < 4; iteration++) {
      scene.setLayers([sky, ruins])
      await Promise.resolve()
      scene.render(bounds, camera, viewport)
      const [oldSky, oldRuins] = scene.background.children
      const sharedTexture = oldSky.texture
      const retiredTexture = oldRuins.texture
      scene.setLayers([sky, mapBottomForeground])
      await Promise.resolve()
      scene.render(bounds, camera, viewport)
      expect(scene.background.children[0].texture).toBe(sharedTexture)
      expect(oldSky.destroyed && oldRuins.destroyed && retiredTexture.destroyed).toBe(true)
      const remaining = [...scene.background.children, ...scene.foreground.children]
      scene.setLayers(undefined)
      expect(remaining.every(({ destroyed }) => destroyed)).toBe(true)
      expect(sharedTexture.destroyed).toBe(true)
      expect(scene.background.children).toHaveLength(0)
      expect(scene.foreground.children).toHaveLength(0)
      expect(scene.stats()).toEqual({ decodedBytes: 0, loaded: 0, displayObjects: 0, visible: 0 })
    }
    expect(load).toHaveBeenCalledTimes(12)
    scene.destroy()
  })

  test('missing or failed textures leave the backdrop available and a retired decode is closed', async () => {
    let complete
    const load = vi.fn((asset) =>
      asset.id === ruins.assetId
        ? Promise.reject(new Error('missing'))
        : new Promise((resolve) => {
            complete = resolve
          })
    )
    const scene = createParallaxRenderer(assets, '/', load)
    scene.setLayers([{ ...far, assetId: 'unknown' }, ruins, sky])
    await Promise.resolve()
    expect(scene.render(bounds, camera, viewport)).toBe(false)
    expect(scene.background.children.every(({ visible }) => !visible)).toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
    scene.setLayers(undefined)
    expect(load.mock.calls[1][2].aborted).toBe(true)
    const pending = imageResource()
    complete(pending)
    await Promise.resolve()
    expect(pending.destroy).toHaveBeenCalledTimes(1)
    expect(scene.background.children).toHaveLength(0)
    scene.destroy()
  })
})

test('only Forest Entrance has configured experimental layers and production does not emit those original PNGs', () => {
  expect([...experimentalMapParallax.keys()]).toEqual(['m1'])
  const production = loadProjectAssets()
  expect(production.catalog.experimentalParallax).toBeUndefined()
  expect([...production.files.keys()].some((path) => path.includes('/forest-'))).toBe(false)
  const dev = loadProjectAssets(false, true)
  expect(dev.catalog.experimentalParallax.map(({ id }) => id)).toEqual(forestParallax.map(({ assetId }) => assetId))
})
