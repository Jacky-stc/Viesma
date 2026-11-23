export const beginnerStates = ['idle', 'run', 'jump', 'fall', 'attack', 'hurt', 'death'] as const

export const visualIds = {
  beginner: 'beginner',
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

export interface SpriteAsset {
  readonly id: string
  readonly type: 'player' | 'monster' | 'tile' | 'npc' | 'loot'
  readonly renderWidth: number
  readonly renderHeight: number
  readonly clips: Readonly<Record<string, SpriteClip>>
}

export interface AssetAtlas {
  readonly id: string
  readonly width: number
  readonly height: number
  readonly output: string
  readonly sprites: readonly SpriteAsset[]
}

export interface AssetCatalog {
  readonly schemaVersion: 1
  readonly atlases: readonly AssetAtlas[]
}

export function indexSprites(catalog: AssetCatalog) {
  return new Map(catalog.atlases.flatMap((atlas) => atlas.sprites.map((sprite) => [sprite.id, { atlas, sprite }] as const)))
}

export function resolveFrame(clip: SpriteClip, elapsedTicks: number) {
  const elapsedFrames = Math.floor(Math.max(0, elapsedTicks) / clip.ticksPerFrame)
  return clip.frames[clip.loop ? elapsedFrames % clip.frames.length : Math.min(elapsedFrames, clip.frames.length - 1)]
}
