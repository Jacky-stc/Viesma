import { visualIds, type FaceCalibration } from './assets/catalog'
import type { PlayerVisualFrame } from './player-view'

export const characterPreviewHeights = [48, 56, 64, 72, 80, 90] as const
export const idlePreviewFrames = [0, 1, 2, 3] as const
export const idlePreviewSpeeds = [0.5, 1, 2] as const
type PreviewHeight = (typeof characterPreviewHeights)[number]

export const characterPreviewModes = {
  'base-body': { defaultHeight: 80, spriteId: visualIds.beginnerBaseBody, sourceFacing: 'left' },
  'animated-base-body': { defaultHeight: 80, spriteId: visualIds.beginnerIdle, sourceFacing: 'left' },
  'paper-doll': { defaultHeight: 80, spriteId: visualIds.beginnerIdle, sourceFacing: 'left' },
  'character-master': { defaultHeight: 64, spriteId: visualIds.beginnerStatic, sourceFacing: 'left' },
  legacy: { defaultHeight: 64, spriteId: undefined, sourceFacing: 'right' },
} as const satisfies Record<
  string,
  { readonly defaultHeight: PreviewHeight; readonly spriteId: string | undefined; readonly sourceFacing: PlayerVisualFrame['facing'] }
>

export type CharacterPreviewMode = keyof typeof characterPreviewModes

export const initialFaceCalibration: FaceCalibration = { xPx: 0, yPx: 0, scale: 1 }

export interface CharacterPreviewOptions {
  readonly height: PreviewHeight
  readonly mode: CharacterPreviewMode
  readonly showCollision: boolean
  readonly showFootAnchor: boolean
  readonly showDiagnosticLayers: boolean
  readonly showFace: boolean
  readonly faceCalibration: FaceCalibration
  readonly showLayerOrder: boolean
  readonly facing: PlayerVisualFrame['facing'] | 'gameplay'
  readonly idle: {
    readonly playing: boolean
    readonly frame: (typeof idlePreviewFrames)[number] | null
    readonly speed: (typeof idlePreviewSpeeds)[number]
    readonly showAttachments: boolean
  }
}

export interface CharacterPreviewRef {
  readonly current: CharacterPreviewOptions
}

export const defaultCharacterPreview: CharacterPreviewOptions = {
  mode: 'base-body',
  height: characterPreviewModes['base-body'].defaultHeight,
  showCollision: false,
  showFootAnchor: false,
  showDiagnosticLayers: false,
  showFace: true,
  faceCalibration: initialFaceCalibration,
  showLayerOrder: false,
  facing: 'gameplay',
  idle: { playing: true, frame: null, speed: 0.5, showAttachments: false },
}
