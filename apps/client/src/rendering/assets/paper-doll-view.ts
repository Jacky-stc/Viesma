import { Container, Sprite, type Texture } from 'pixi.js'
import type { AtlasScope } from './atlas-scope'
import { paperDollSlots, type BeginnerIdlePose, type FaceCalibration, type idleAttachmentIds, type PaperDollSlot } from './catalog'

interface PixelPoint {
  readonly x: number
  readonly y: number
}

export type PaperDollLayer =
  | {
      readonly kind: 'attached'
      readonly spriteId: string
      readonly attachment: (typeof idleAttachmentIds)[number]
      readonly originPx: PixelPoint
    }
  | { readonly kind: 'pose'; readonly spriteId: string; readonly offsetPx: PixelPoint }

export type PaperDollLayers = Readonly<Partial<Record<Exclude<PaperDollSlot, 'baseBody'>, PaperDollLayer | null>>>
type PoseFrame = BeginnerIdlePose['frames'][number]

const splitParts = [
  ['upperClothing', 'upperClothingFront'],
  ['accessoryBack', 'accessoryFront'],
  ['weaponBack', 'weaponFront'],
] as const

export function createPaperDollView(assets: AtlasScope, pivotPx: PixelPoint) {
  const root = new Container({ visible: false })
  const layersRoot = new Container()
  root.addChild(layersRoot)
  const sprites = new Map<PaperDollSlot, Sprite>()
  let lastFrame: PoseFrame | undefined
  let lastAnimationId: string | undefined
  let lastBaseTexture: Texture | undefined
  let lastLayers: PaperDollLayers | undefined
  let lastOrder: readonly PaperDollSlot[] | undefined
  let lastFaceCalibration: FaceCalibration | undefined
  let lastRevision = -1
  let visibleOrder = ''

  return {
    root,
    get order() {
      return visibleOrder
    },
    get attachments() {
      return lastFrame?.attachments
    },
    draw(
      frame: PoseFrame,
      animationId: string,
      frameIndex: number,
      baseTexture: Texture,
      order: readonly PaperDollSlot[],
      layers: PaperDollLayers | undefined,
      x: number,
      y: number,
      scale: number,
      mirror: number,
      faceCalibration?: FaceCalibration
    ) {
      root.visible = true
      root.position.set(x, y)
      layersRoot.scale.set(scale * mirror, scale)
      if (
        lastFrame !== frame ||
        lastAnimationId !== animationId ||
        lastBaseTexture !== baseTexture ||
        lastLayers !== layers ||
        lastOrder !== order ||
        lastRevision !== assets.revision ||
        lastFaceCalibration !== faceCalibration
      ) {
        lastFrame = frame
        lastAnimationId = animationId
        lastBaseTexture = baseTexture
        lastLayers = layers
        lastOrder = order
        lastRevision = assets.revision
        lastFaceCalibration = faceCalibration
        const textures = new Map<PaperDollSlot, Texture | null>([['baseBody', baseTexture]])
        for (const slot of order) {
          if (slot === 'baseBody') continue
          const layer = layers?.[slot]
          if (layer === null) textures.set(slot, null)
          else if (layer) {
            const texture =
              layer.kind === 'attached'
                ? assets.textureAt(layer.spriteId, 'idle', 0)
                : assets.textureAt(layer.spriteId, animationId, frameIndex)
            if (texture) textures.set(slot, texture)
          }
        }
        for (const [first, second] of splitParts) {
          if (order.includes(first) && order.includes(second) && (!textures.has(first) || !textures.has(second))) {
            textures.delete(first)
            textures.delete(second)
          }
        }
        if (!textures.get('weaponBack') && !textures.get('weaponFront')) textures.delete('bodyForeground')

        const visibleSlots = order.filter((slot) => textures.get(slot))
        visibleOrder = visibleSlots.join(' → ')
        for (const [slot, sprite] of sprites) sprite.visible = Boolean(textures.get(slot))
        for (const [index, slot] of visibleSlots.entries()) {
          const texture = textures.get(slot)
          if (!texture) continue
          let sprite = sprites.get(slot)
          if (!sprite) {
            sprite = new Sprite()
            sprites.set(slot, sprite)
            layersRoot.addChild(sprite)
          }
          if (layersRoot.getChildIndex(sprite) !== index) layersRoot.setChildIndex(sprite, index)
          sprite.texture = texture
          const layer = slot === 'baseBody' ? undefined : layers?.[slot]
          const calibration = slot === 'face' ? faceCalibration : undefined
          sprite.scale.set(calibration?.scale ?? 1)
          if (layer?.kind === 'attached') {
            const { x, y, rotationDeg } = frame.attachments[layer.attachment]
            sprite.pivot.set(layer.originPx.x, layer.originPx.y)
            sprite.position.set(x - pivotPx.x + (calibration?.xPx ?? 0), y - pivotPx.y + (calibration?.yPx ?? 0))
            sprite.angle = rotationDeg
          } else {
            const offset = layer?.offsetPx ?? frame.offsetPx
            sprite.pivot.set(0, 0)
            sprite.position.set(offset.x - pivotPx.x, offset.y - pivotPx.y)
            sprite.angle = 0
          }
        }
      }
    },
  }
}

export const diagnosticSpriteId = 'beginner-diagnostic-back'

function createDiagnostics(): ReadonlyArray<{ readonly order: readonly PaperDollSlot[]; readonly layers: PaperDollLayers }> {
  const backHair = { kind: 'attached', spriteId: diagnosticSpriteId, attachment: 'head', originPx: { x: 21, y: 31 } } as const
  const face = { kind: 'attached', spriteId: 'beginner-diagnostic-face', attachment: 'face', originPx: { x: 15, y: 9 } } as const
  const frontHair = { kind: 'attached', spriteId: 'beginner-diagnostic-front', attachment: 'head', originPx: { x: 55, y: 52 } } as const
  const layers: PaperDollLayers = { backHair, face, frontHair }
  return [
    { order: paperDollSlots, layers },
    { order: paperDollSlots, layers },
    { order: ['backHair', 'baseBody', 'frontHair', 'face'], layers },
    { order: paperDollSlots, layers: { backHair, face } },
  ]
}

export const paperDollDiagnostics = import.meta.env.DEV ? createDiagnostics() : []
