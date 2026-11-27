import { ImageSource, type SCALE_MODE } from 'pixi.js'
import type { TextureImageAsset } from './catalog'

export async function loadTextureImage(image: TextureImageAsset, baseUrl: string, signal: AbortSignal, scaleMode: SCALE_MODE) {
  const response = await fetch(baseUrl + image.output, { signal })
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
    throw new Error(`Image unavailable: ${image.id}`)
  }
  const bitmap = await createImageBitmap(await response.blob())
  if (signal.aborted || bitmap.width !== image.width || bitmap.height !== image.height) {
    bitmap.close()
    throw new Error(`Image decode cancelled or dimensions disagree: ${image.id}`)
  }
  const source = new ImageSource({ resource: bitmap, scaleMode })
  return {
    source,
    destroy() {
      source.destroy()
      bitmap.close()
    },
  }
}
