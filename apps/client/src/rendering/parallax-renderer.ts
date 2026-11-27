import type { Aabb } from '@viesma/physics'
import { Container, Sprite, Texture, TilingSprite } from 'pixi.js'
import type { TextureImageAsset } from './assets/catalog'
import { loadTextureImage } from './assets/texture-image'
import type { CameraView, ViewportSize } from './camera'
import { positionGroundParallax, positionParallax, type ParallaxLayer } from './parallax-layout'

interface LayerImage {
  readonly texture: Texture
  destroy(): void
}

interface ImageRequest {
  readonly controller: AbortController
  image?: LayerImage
}

interface LayerView {
  readonly layer: ParallaxLayer
  readonly view: Sprite | TilingSprite
  readonly band: Aabb | undefined
}

export interface ParallaxStats {
  readonly decodedBytes: number
  readonly loaded: number
  readonly displayObjects: number
  readonly visible: number
}

export function createParallaxRenderer(assets: readonly TextureImageAsset[], baseUrl: string, load = loadTextureImage) {
  const background = new Container()
  const foreground = new Container()
  const catalog = new Map(assets.map((asset) => [asset.id, asset]))
  const requests = new Map<string, ImageRequest>()
  let activeLayers: readonly ParallaxLayer[] | undefined
  let activeBands: readonly Aabb[] | undefined
  let views: LayerView[] = []

  function releaseUnneeded(required: ReadonlySet<string>) {
    for (const [id, request] of requests) {
      if (required.has(id)) continue
      request.controller.abort()
      request.image?.destroy()
      requests.delete(id)
    }
  }

  function prepare(id: string) {
    const asset = catalog.get(id)
    if (!asset || requests.has(id)) return
    const request: ImageRequest = { controller: new AbortController() }
    const { signal } = request.controller
    requests.set(id, request)
    void load(asset, baseUrl, signal, 'linear')
      .then((image) => {
        if (signal.aborted) {
          image.destroy()
          return
        }
        const texture = new Texture({ source: image.source })
        request.image = {
          texture,
          destroy() {
            texture.destroy()
            image.destroy()
          },
        }
      })
      .catch(() => {
        // 可播放的場景會沿用平面背景，或略過缺失的裝飾。
      })
  }

  function setLayers(layers: readonly ParallaxLayer[] | undefined, bands?: readonly Aabb[]) {
    if (activeLayers === layers && activeBands === bands) return
    activeLayers = layers
    activeBands = bands
    for (const { view } of views) view.destroy()
    const ordered = (layers ?? [])
      .filter(({ placement }) => placement !== 'ground-band' || !!bands?.length)
      .sort((a, b) => a.order - b.order)
    releaseUnneeded(new Set(ordered.map(({ assetId }) => assetId)))
    views = ordered.flatMap((layer) => {
      prepare(layer.assetId)
      const plane = layer.plane === 'background' ? background : foreground
      const regions = layer.placement === 'ground-band' ? (bands ?? []) : [undefined]
      return regions.map((band) => {
        const view = layer.repeatX || band ? new TilingSprite({ texture: Texture.EMPTY }) : new Sprite(Texture.EMPTY)
        view.visible = false
        view.alpha = layer.opacity
        plane.addChild(view)
        return { layer, view, band }
      })
    })
  }

  return {
    background,
    foreground,
    setLayers,
    render(bounds: Aabb, camera: CameraView, viewport: ViewportSize) {
      let hasBackground = false
      for (const { layer, view, band } of views) {
        const texture = requests.get(layer.assetId)?.image?.texture
        const layout =
          layer.visible && layer.opacity > 0 && texture
            ? band
              ? positionGroundParallax(layer, texture, bounds, band, camera, viewport)
              : { ...positionParallax(layer, texture, bounds, camera, viewport), phaseY: 0 }
            : undefined
        view.visible = layout !== undefined
        if (!layout || !texture) continue
        if (layer.plane === 'background') hasBackground = true
        if (view.texture !== texture) view.texture = texture
        const { x, y, width, height, scale, phaseX, phaseY } = layout
        view.position.set(x, y)
        if (view instanceof TilingSprite) {
          if (view.width !== width) view.width = width
          if (view.height !== height) view.height = height
          view.tileScale.set(scale)
          view.tilePosition.set(phaseX, phaseY)
        } else {
          view.scale.set(scale)
        }
      }
      return hasBackground
    },
    stats(): ParallaxStats {
      let decodedBytes = 0
      let loaded = 0
      for (const { image } of requests.values()) {
        if (!image) continue
        loaded++
        decodedBytes += image.texture.width * image.texture.height * 4
      }
      return { decodedBytes, loaded, displayObjects: views.length, visible: views.filter(({ view }) => view.visible).length }
    },
    destroy() {
      setLayers(undefined)
      background.destroy()
      foreground.destroy()
    },
  }
}
