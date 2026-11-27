export const beginnerStates = ['idle', 'run', 'jump', 'fall', 'attack', 'hurt', 'death'] as const
export const face01SpriteId = 'beginner-face-01'

export const visualIds = {
  beginner: 'beginner',
  beginnerStatic: 'beginner-static',
  beginnerBaseBody: 'beginner-base-body',
  beginnerIdle: 'beginner-base-body-idle',
  guide: 'village-guide',
  trailTile: 'village-trail-tile',
  loot: 'loot-pouch',
  monsters: { slime: 'slime', mushroom: 'mushroom', bat: 'bat' },
} as const

export interface AtlasFrame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface SpriteClip {
  readonly frames: readonly AtlasFrame[]
  readonly ticksPerFrame: number
  readonly loop: boolean
}

export const idleAttachmentIds = ['head', 'face', 'torso', 'mainHand', 'offHand', 'foot', 'nearSole', 'farSole'] as const

export const paperDollSlots = [
  'accessoryBack',
  'backHair',
  'weaponBack',
  'baseBody',
  'lowerClothing',
  'shoes',
  'upperClothing',
  'face',
  'frontHair',
  'upperClothingFront',
  'weaponFront',
  'bodyForeground',
  'accessoryFront',
] as const

export type PaperDollSlot = (typeof paperDollSlots)[number]

export interface IdleAttachment {
  readonly x: number
  readonly y: number
  readonly rotationDeg: number
}

export interface BeginnerIdlePose {
  readonly pivotPx: { readonly x: number; readonly y: number }
  readonly worldUnitsPerPixel: number
  readonly ticksPerFrame: number
  readonly frames: ReadonlyArray<{
    readonly offsetPx: { readonly x: number; readonly y: number }
    readonly drawOrder: readonly PaperDollSlot[]
    readonly attachments: Readonly<Record<(typeof idleAttachmentIds)[number], IdleAttachment>>
  }>
}

export interface SpriteAsset {
  readonly id: string
  readonly type: 'player' | 'monster' | 'tile' | 'npc' | 'loot'
  readonly renderWidth: number
  readonly renderHeight: number
  readonly clips: Readonly<Record<string, SpriteClip>>
  readonly idlePose?: BeginnerIdlePose
  readonly attachedFace?: AttachedFaceAsset
}

export interface AttachedFaceAsset {
  readonly defaultCalibration: FaceCalibration
  readonly originPx: { readonly x: number; readonly y: number }
  readonly offsetPx: { readonly x: number; readonly y: number }
}

export interface FaceCalibration {
  readonly xPx: number
  readonly yPx: number
  readonly scale: number
}

export interface TextureImageAsset {
  readonly id: string
  readonly width: number
  readonly height: number
  readonly output: string
}

export interface AssetAtlas extends TextureImageAsset {
  readonly sprites: readonly SpriteAsset[]
}

export interface AssetCatalog {
  readonly schemaVersion: 1
  readonly atlases: readonly AssetAtlas[]
  readonly experimentalParallax?: readonly TextureImageAsset[]
}

export function indexSprites(catalog: AssetCatalog) {
  return new Map(catalog.atlases.flatMap((atlas) => atlas.sprites.map((sprite) => [sprite.id, { atlas, sprite }] as const)))
}

export function resolveFrame(clip: SpriteClip, elapsedTicks: number) {
  const elapsedFrames = Math.floor(Math.max(0, elapsedTicks) / clip.ticksPerFrame)
  return clip.frames[clip.loop ? elapsedFrames % clip.frames.length : Math.min(elapsedFrames, clip.frames.length - 1)]
}
