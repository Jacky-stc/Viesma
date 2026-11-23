import { ImageSource, Rectangle, Texture } from 'pixi.js'
import { resolveFrame, type AssetAtlas, type AtlasFrame, type indexSprites } from './catalog'

interface LoadedAtlas {
  frame(rectangle: AtlasFrame): Texture
  destroy(): void
}

async function loadAtlas(atlas: AssetAtlas, baseUrl: string, signal: AbortSignal): Promise<LoadedAtlas> {
  const response = await fetch(baseUrl + atlas.output, { signal })
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
    throw new Error(`Atlas unavailable: ${atlas.id}`)
  }
  const bitmap = await createImageBitmap(await response.blob())
  if (signal.aborted || bitmap.width !== atlas.width || bitmap.height !== atlas.height) {
    bitmap.close()
    throw new Error(`Atlas decode cancelled or dimensions disagree: ${atlas.id}`)
  }
  const source = new ImageSource({ resource: bitmap, scaleMode: 'nearest' })
  const textures = new Map<AtlasFrame, Texture>()

  return {
    frame(rectangle) {
      let texture = textures.get(rectangle)
      if (!texture) {
        const { x, y, width, height } = rectangle
        texture = new Texture({ source, frame: new Rectangle(x, y, width, height) })
        textures.set(rectangle, texture)
      }
      return texture
    },
    destroy() {
      for (const texture of textures.values()) texture.destroy()
      source.destroy()
      bitmap.close()
    },
  }
}

export function createAtlasScope(sprites: ReturnType<typeof indexSprites>, baseUrl: string, load = loadAtlas) {
  const controller = new AbortController()
  const requested = new Set<string>()
  const loaded = new Map<string, LoadedAtlas>()

  return {
    prepare(id: string) {
      const atlas = sprites.get(id)?.atlas
      if (!atlas || requested.has(atlas.id) || controller.signal.aborted) return
      requested.add(atlas.id)
      void load(atlas, baseUrl, controller.signal)
        .then((resource) => {
          if (controller.signal.aborted) resource.destroy()
          else loaded.set(atlas.id, resource)
        })
        .catch(() => {
          // 載入失敗時沿用圖形或略過裝飾。該場景的同一張圖集只嘗試一次。
        })
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
