import { Rectangle, Texture, type SCALE_MODE } from 'pixi.js'
import { resolveFrame, type AssetAtlas, type AtlasFrame, type indexSprites } from './catalog'
import { loadTextureImage } from './texture-image'

interface LoadedAtlas {
  frame(rectangle: AtlasFrame): Texture
  destroy(): void
}

type AtlasLoader = (atlas: AssetAtlas, baseUrl: string, signal: AbortSignal) => Promise<LoadedAtlas>

async function loadAtlas(atlas: AssetAtlas, baseUrl: string, signal: AbortSignal, scaleMode: SCALE_MODE): Promise<LoadedAtlas> {
  const image = await loadTextureImage(atlas, baseUrl, signal, scaleMode)
  const textures = new Map<AtlasFrame, Texture>()

  return {
    frame(rectangle) {
      let texture = textures.get(rectangle)
      if (!texture) {
        const { x, y, width, height } = rectangle
        texture = new Texture({ source: image.source, frame: new Rectangle(x, y, width, height) })
        textures.set(rectangle, texture)
      }
      return texture
    },
    destroy() {
      for (const texture of textures.values()) texture.destroy()
      image.destroy()
    },
  }
}

export function createAtlasScope(
  sprites: ReturnType<typeof indexSprites>,
  baseUrl: string,
  load?: AtlasLoader,
  scaleMode: SCALE_MODE = 'nearest'
) {
  const controller = new AbortController()
  const requested = new Set<string>()
  const loaded = new Map<string, LoadedAtlas>()
  let revision = 0

  return {
    get revision() {
      return revision
    },
    prepare(id: string, preloadFrames = false) {
      const entry = sprites.get(id)
      if (!entry || requested.has(entry.atlas.id) || controller.signal.aborted) return
      const { atlas, sprite } = entry
      requested.add(atlas.id)
      const pending = load ? load(atlas, baseUrl, controller.signal) : loadAtlas(atlas, baseUrl, controller.signal, scaleMode)
      void pending
        .then((resource) => {
          if (controller.signal.aborted) {
            resource.destroy()
          } else {
            // Idle texture views are prepared together so frame changes only swap references.
            if (preloadFrames) {
              for (const entry of atlas.sprites) {
                for (const clip of Object.values(entry.clips)) for (const frame of clip.frames) resource.frame(frame)
              }
            } else if (sprite.idlePose) {
              for (const frame of sprite.clips.idle?.frames ?? []) resource.frame(frame)
            }
            loaded.set(atlas.id, resource)
            revision++
          }
        })
        .catch(() => {
          // 載入失敗時沿用圖形或略過裝飾。該場景的同一張圖集只嘗試一次。
        })
    },
    textureAt(id: string, animationId: string, frameIndex: number) {
      const entry = sprites.get(id)
      if (!entry || !Object.hasOwn(entry.sprite.clips, animationId)) return undefined
      const frame = entry.sprite.clips[animationId]?.frames[frameIndex]
      return frame && loaded.get(entry.atlas.id)?.frame(frame)
    },
    resolve(id: string, state: string, ticks: number) {
      const entry = sprites.get(id)
      if (!entry) return undefined
      const { atlas, sprite } = entry
      const resource = loaded.get(atlas.id)
      const clip = Object.hasOwn(sprite.clips, state) ? sprite.clips[state] : undefined
      const frame = clip && resolveFrame(clip, ticks)
      if (!resource || !frame) return undefined
      return { texture: resource.frame(frame), width: sprite.renderWidth, height: sprite.renderHeight }
    },
    destroy() {
      controller.abort()
      for (const resource of loaded.values()) resource.destroy()
      loaded.clear()
    },
  }
}

export type AtlasScope = ReturnType<typeof createAtlasScope>
