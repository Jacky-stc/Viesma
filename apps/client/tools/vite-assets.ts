import { Buffer } from 'node:buffer'
import type { Plugin } from 'vite'
import { loadProjectAssets } from './asset-project.ts'

const virtualId = 'virtual:viesma-assets'
const resolvedId = '\0' + virtualId
const mediaFile =
  /\.(?:apng|avif|bmp|cur|dds|gif|heic|ico|jpe?g|ktx2?|png|svg|tiff?|webp|aac|flac|m4a|mp3|ogg|opus|wav|webm|mp4|woff2?|ttf|otf)(?:[?#]|$)/i

export function viesmaAssets(): Plugin {
  let assets: ReturnType<typeof loadProjectAssets>
  let building = false

  return {
    name: 'viesma-assets',
    enforce: 'pre',
    config(_config, { command, isPreview }) {
      building = command === 'build'
      // Preview 直接供應已建置的輸出。
      if (!isPreview) assets = loadProjectAssets(!building)
      return { publicDir: false, build: { assetsInlineLimit: 0 } }
    },
    resolveId(id) {
      if (id === virtualId) return resolvedId
      if (building && mediaFile.test(id)) this.error(`Unapproved media import: ${id}. Register it in the asset manifest.`)
    },
    load(id) {
      if (id === resolvedId) return `export default ${JSON.stringify(assets.catalog)}`
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0]?.slice(server.config.base.length)
        if (!request.url?.startsWith(server.config.base) || !path?.startsWith('game-assets/')) return next()
        const bytes = assets.files.get(path)
        response.statusCode = bytes ? 200 : 404
        response.setHeader('Content-Type', bytes && path.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8')
        response.end(bytes ?? 'Asset unavailable')
      })
    },
    buildStart() {
      if (!building) return
      for (const [fileName, source] of assets.files) this.emitFile({ type: 'asset', fileName, source })
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset') continue
        const registered = assets.files.get(output.fileName)
        if (registered) {
          if (!registered.equals(Buffer.from(output.source))) this.error(`Asset output bytes changed: ${output.fileName}`)
        } else if (!/\.(?:html|css|map)$/i.test(output.fileName)) {
          this.error(`Unapproved media output: ${output.fileName}. Register it in the asset manifest.`)
        }
      }
    },
  }
}
