import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAssetCatalog, readJson, validateTiledAssetReferences } from './asset-manifest.ts'

export const assetRoot = fileURLToPath(new URL('../../../content/assets/', import.meta.url))
const manifestFile = new URL('../../../content/assets/manifest.json', import.meta.url)
const mapsRoot = fileURLToPath(new URL('../../../packages/game-data/src/maps/', import.meta.url))

export function loadProjectAssets(development = false) {
  const assets = buildAssetCatalog(readJson(readFileSync(manifestFile), 'manifest.json'), assetRoot, development)
  const mapFiles = readdirSync(mapsRoot)
    .filter((file) => /^(?:village|m[1-6])\.json$/.test(file))
    .sort()
  validateTiledAssetReferences(mapsRoot, mapFiles, assets)
  return assets
}
