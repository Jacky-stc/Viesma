import type { Aabb } from '@viesma/physics'
import type { CameraView, ViewportSize } from './camera'

export interface ParallaxLayer {
  readonly assetId: string
  readonly plane: 'background' | 'foreground'
  readonly order: number
  readonly placement: 'viewport-cover' | 'map-bottom' | 'ground-band'
  readonly factorX: number
  readonly factorY: number
  readonly scale: number
  readonly offsetX: number
  readonly offsetY: number
  readonly opacity: number
  readonly repeatX: boolean
  readonly visible: boolean
}

export function positionParallax(layer: ParallaxLayer, image: ViewportSize, bounds: Aabb, camera: CameraView, viewport: ViewportSize) {
  const cover = layer.placement === 'viewport-cover'
  const scale = cover
    ? Math.max(camera.scale * layer.scale, viewport.width / image.width, viewport.height / image.height)
    : camera.scale * layer.scale
  const width = image.width * scale
  const height = image.height * scale
  const shiftX = (layer.offsetX - (camera.origin.x - bounds.origin.x) * layer.factorX) * camera.scale
  const shiftY = (layer.offsetY - (camera.origin.y - bounds.origin.y) * layer.factorY) * camera.scale
  const x = cover ? (viewport.width - width) / 2 + shiftX : shiftX
  const boundedX = cover ? Math.max(viewport.width - width, Math.min(0, x)) : x
  const y = cover
    ? Math.max(viewport.height - height, Math.min(0, (viewport.height - height) / 2 + shiftY))
    : bounds.height * camera.scale - height + shiftY
  return {
    x: layer.repeatX ? 0 : boundedX,
    y,
    width: layer.repeatX ? viewport.width : width,
    height,
    scale,
    phaseX: ((x % width) + width) % width,
  }
}

export function positionGroundParallax(
  layer: ParallaxLayer,
  image: ViewportSize,
  map: Aabb,
  band: Aabb,
  camera: CameraView,
  viewport: ViewportSize
) {
  const zoom = camera.scale
  const scale = layer.scale * zoom
  const tileWidth = image.width * scale
  const tileHeight = image.height * scale
  const textureX = (layer.offsetX - (camera.origin.x - map.origin.x) * layer.factorX) * zoom
  const textureY =
    (band.origin.y + band.height - map.origin.y + layer.offsetY - (camera.origin.y - map.origin.y) * layer.factorY) * zoom - tileHeight
  const bandX = (band.origin.x - camera.origin.x) * zoom
  const bandY = (band.origin.y - camera.origin.y) * zoom
  const x = Math.max(0, bandX, layer.repeatX ? 0 : textureX)
  const right = Math.min(viewport.width, bandX + band.width * zoom, layer.repeatX ? viewport.width : textureX + tileWidth)
  const y = Math.max(0, bandY, textureY)
  const bottom = Math.min(viewport.height, bandY + band.height * zoom, textureY + tileHeight)
  if (right <= x || bottom <= y) return undefined
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
    scale,
    phaseX: (((textureX - x) % tileWidth) + tileWidth) % tileWidth,
    phaseY: textureY - y,
  }
}
