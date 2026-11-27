import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { addExperimentalParallax, buildAssetCatalog, readJson, validateTiledAssetReferences } from './asset-manifest.ts'

export const assetRoot = fileURLToPath(new URL('../../../content/assets/', import.meta.url))
const manifestFile = new URL('../../../content/assets/manifest.json', import.meta.url)
const mapsRoot = fileURLToPath(new URL('../../../packages/game-data/src/maps/', import.meta.url))
const parallaxManifest = new URL('../../../content/assets/experimental-parallax.json', import.meta.url)
const terrainManifest = new URL('../../../content/assets/experimental-terrain.json', import.meta.url)
const organicTerrainManifest = new URL('../../../content/assets/experimental-organic-terrain.json', import.meta.url)
const characterManifest = new URL('../../../content/assets/experimental-character.json', import.meta.url)
export const characterManifestPath = fileURLToPath(characterManifest)
const parallaxRoot = fileURLToPath(new URL('../../../art/source/environments/', import.meta.url))

export function loadProjectAssets(development = false, experimental = development) {
  const experimentalAtlases = experimental
    ? [terrainManifest, organicTerrainManifest, characterManifest].map((file) => readJson(readFileSync(file), file.pathname))
    : []
  const assets = buildAssetCatalog(readJson(readFileSync(manifestFile), 'manifest.json'), assetRoot, development, ...experimentalAtlases)
  const mapFiles = readdirSync(mapsRoot)
    .filter((file) => /^(?:village|m[1-6])\.json$/.test(file))
    .sort()
  validateTiledAssetReferences(mapsRoot, mapFiles, assets)
  return experimental
    ? addExperimentalParallax(
        assets,
        readJson(readFileSync(parallaxManifest), 'experimental-parallax.json'),
        parallaxRoot,
        assetRoot,
        development
      )
    : assets
}
