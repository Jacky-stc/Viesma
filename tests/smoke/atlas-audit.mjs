export async function installAtlasAudit(page) {
  await page.addInitScript(() => {
    const create = globalThis.createImageBitmap
    const close = globalThis.ImageBitmap.prototype.close
    const bitmaps = new Map()
    const textures = new Map()
    const dimensions = { '192x168': 'beginner', '64x48': 'village', '128x32': 'field' }
    globalThis.createImageBitmap = async (...args) => {
      const bitmap = await create(...args)
      const atlas = args[0] instanceof globalThis.Blob && args[0].type === 'image/png' && dimensions[bitmap.width + 'x' + bitmap.height]
      if (atlas) bitmaps.set(bitmap, atlas)
      return bitmap
    }
    globalThis.ImageBitmap.prototype.close = function () {
      bitmaps.delete(this)
      return close.call(this)
    }
    for (const context of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
      const prototype = context.prototype
      for (const method of ['texImage2D', 'texSubImage2D']) {
        if (!Object.hasOwn(prototype, method)) continue
        const upload = prototype[method]
        prototype[method] = function (...args) {
          const result = upload.apply(this, args)
          const atlas = bitmaps.get(args.at(-1))
          if (atlas && args[0] === this.TEXTURE_2D) {
            const texture = this.getParameter(this.TEXTURE_BINDING_2D)
            if (texture) textures.set(texture, atlas)
          }
          return result
        }
      }
      if (!Object.hasOwn(prototype, 'deleteTexture')) continue
      const release = prototype.deleteTexture
      prototype.deleteTexture = function (texture) {
        textures.delete(texture)
        return release.call(this, texture)
      }
    }
    globalThis.readAtlasAudit = () => ({
      bitmaps: [...bitmaps.values()].sort(),
      textures: [...textures.values()].sort(),
    })
  })
}

export function readAtlasAudit(page) {
  return page.evaluate(() => globalThis.readAtlasAudit())
}
