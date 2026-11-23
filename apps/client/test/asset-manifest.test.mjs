import { loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { indexSprites, visualIds } from '../src/rendering/assets/catalog.ts'
import { attributionPath, buildAssetCatalog, validateTiledAssetReferences } from '../tools/asset-manifest.ts'
import { assetRoot, loadProjectAssets } from '../tools/asset-project.ts'
import { viesmaAssets } from '../tools/vite-assets.ts'

let root
let input
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'viesma-assets-'))
  cpSync(assetRoot, root, { recursive: true })
  input = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('registered assets', () => {
  test('resolves the three atlases and all seven visual IDs', () => {
    const { catalog, files } = loadProjectAssets()
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.atlases).toHaveLength(3)
    expect([...indexSprites(catalog).keys()].sort()).toEqual(
      [visualIds.beginner, visualIds.guide, visualIds.trailTile, visualIds.loot, ...Object.values(visualIds.monsters)].sort()
    )
    expect(files.get(attributionPath).toString()).toContain('Generator: draw-graybox.mjs')
  })

  test('canonicalizes unordered entries and emits the same names and bytes', () => {
    const first = buildAssetCatalog(input, root)
    input.atlases.reverse()
    for (const atlas of input.atlases) {
      atlas.sprites.reverse()
      for (const sprite of atlas.sprites) sprite.clips = Object.fromEntries(Object.entries(sprite.clips).reverse())
    }
    const second = buildAssetCatalog(input, root)
    expect(JSON.stringify(second.catalog)).toBe(JSON.stringify(first.catalog))
    expect([...second.files]).toEqual([...first.files])
  })

  test('permits only an explicitly optional missing PNG in development', () => {
    const field = input.atlases.find(({ id }) => id === 'field-atlas')
    rmSync(join(root, field.source))
    expect(() => buildAssetCatalog(input, root)).toThrow(expect.objectContaining({ code: 'MISSING_FILE' }))
    const { catalog, files } = buildAssetCatalog(input, root, true)
    expect(files.has(indexSprites(catalog).get('slime').atlas.output)).toBe(false)
    field.optionalInDevelopment = false
    expect(() => buildAssetCatalog(input, root, true)).toThrow(expect.objectContaining({ code: 'MISSING_FILE' }))
  })

  test.each([
    [
      'duplicate atlas ID',
      'DUPLICATE_ID',
      (atlas, input) => {
        input.atlases[1].id = atlas.id
      },
    ],
    [
      'duplicate sprite ID',
      'DUPLICATE_ID',
      (atlas) => {
        atlas.sprites.push(atlas.sprites[0])
      },
    ],
    [
      'image dimensions',
      'INVALID_DIMENSIONS',
      (atlas) => {
        atlas.width++
      },
    ],
    [
      'frame bounds',
      'INVALID_DIMENSIONS',
      (atlas) => {
        atlas.sprites[0].clips.idle.frames[0].width = 300
      },
    ],
    [
      'render dimensions',
      'INVALID_DIMENSIONS',
      (atlas) => {
        atlas.sprites[0].renderWidth = 0
      },
    ],
    [
      'source traversal',
      'INVALID_PATH',
      (atlas) => {
        atlas.source = 'images/../beginner.png'
      },
    ],
    [
      'source URL as file',
      'INVALID_PATH',
      (atlas) => {
        atlas.source = 'https://example.invalid/a.png'
      },
    ],
    [
      'incorrect output path',
      'INVALID_PATH',
      (atlas) => {
        atlas.output = 'game-assets/unrelated.png'
      },
    ],
    [
      'unreviewed bytes',
      'DIGEST_MISMATCH',
      (atlas) => {
        atlas.sha256 = '0'.repeat(64)
      },
    ],
    [
      'missing original source',
      'MISSING_FILE',
      (atlas) => {
        atlas.rights.generator = 'missing.mjs'
      },
    ],
    [
      'missing sprite reference',
      'INVALID_REFERENCE',
      (atlas) => {
        atlas.sprites[0].id = 'wrong-id'
      },
    ],
    [
      'missing animation',
      'INVALID_REFERENCE',
      (atlas) => {
        delete atlas.sprites[0].clips.hurt
      },
    ],
  ])('rejects %s', (_label, code, mutate) => {
    mutate(input.atlases[0], input)
    expect(() => buildAssetCatalog(input, root)).toThrow(expect.objectContaining({ code }))
  })

  test('rejects corrupt PNG data even when presented with its exact digest', () => {
    const atlas = input.atlases[0]
    const bytes = readFileSync(join(root, atlas.source)).subarray(0, 70)
    writeFileSync(join(root, atlas.source), bytes)
    atlas.sha256 = createHash('sha256').update(bytes).digest('hex')
    expect(() => buildAssetCatalog(input, root)).toThrow(expect.objectContaining({ code: 'INVALID_IMAGE' }))
  })
})

describe('licensed submissions', () => {
  beforeEach(() => {
    input.atlases[0].rights = {
      kind: 'licensed',
      creator: 'Example Creator',
      license: 'CC-BY-4.0',
      source: 'https://example.invalid/art/fixture',
      attribution: 'Example Atlas by Example Creator. Retain the original notice.',
      changes: 'Cropped to a spritesheet',
      evidence: 'provenance/test.txt',
    }
    writeFileSync(join(root, 'provenance/test.txt'), 'Synthetic license evidence for schema coverage.')
  })

  test('publishes creator, source, license link, original notice and changes', () => {
    const credits = buildAssetCatalog(input, root).files.get(attributionPath).toString()
    expect(credits).toContain('Example Atlas by Example Creator. Retain the original notice.')
    expect(credits).toContain('Source: https://example.invalid/art/fixture')
    expect(credits).toContain('CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)')
    expect(credits).toContain('Changes: Cropped to a spritesheet')
  })

  test.each(['unknown', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'all rights reserved'])('rejects unapproved license %s', (license) => {
    input.atlases[0].rights.license = license
    expect(() => buildAssetCatalog(input, root)).toThrow(expect.objectContaining({ code: 'UNAPPROVED_LICENSE' }))
  })

  test('rejects missing required attribution and publication evidence', () => {
    const rights = input.atlases[0].rights
    delete rights.attribution
    expect(() => buildAssetCatalog(input, root)).toThrow(expect.objectContaining({ code: 'MISSING_ATTRIBUTION' }))
    rights.attribution = 'Example Creator'
    rmSync(join(root, rights.evidence))
    expect(() => buildAssetCatalog(input, root)).toThrow(expect.objectContaining({ code: 'MISSING_FILE' }))
  })
})

test('Tiled image references must match a registered tile atlas by bytes and dimensions', () => {
  const assets = buildAssetCatalog(input, root)
  writeFileSync(join(root, 'map.json'), JSON.stringify({ tilesets: [{ source: 'tiles/atlas.tsj' }] }))
  mkdirSync(join(root, 'tiles'))
  const definition = { image: 'atlas.png', imagewidth: 64, imageheight: 48 }
  writeFileSync(join(root, 'tiles/atlas.tsj'), JSON.stringify(definition))
  const image = join(root, 'tiles/atlas.png')
  cpSync(join(root, 'images/field.png'), image)
  expect(() => validateTiledAssetReferences(root, ['map.json'], assets)).toThrow(expect.objectContaining({ code: 'INVALID_REFERENCE' }))
  cpSync(join(root, 'images/village.png'), image)
  expect(() => validateTiledAssetReferences(root, ['map.json'], assets)).not.toThrow()
  writeFileSync(join(root, 'tiles/atlas.tsj'), JSON.stringify({ ...definition, imagewidth: 65 }))
  expect(() => validateTiledAssetReferences(root, ['map.json'], assets)).toThrow(expect.objectContaining({ code: 'INVALID_DIMENSIONS' }))
})

test('visual assets preserve the shipped seven-map hash with the M2.5 Guide placement', () => {
  loadProjectAssets()
  const hash = createHash('sha256').update(serializeMapManifest(loadGrayboxGameData()), 'utf8').digest('hex')
  expect(hash).toBe('ee0a09e481b4d09daa529cf85a08cb7764685edf809f348a6c2dc62dbe94d5aa')
})

test('Vite refuses an unapproved PNG import even when explicitly inlined', async () => {
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/entry.js"></script>')
  writeFileSync(join(root, 'entry.js'), "import image from './images/field.png?inline'; document.body.textContent = image;")
  await expect(build({ configFile: false, root, logLevel: 'silent', plugins: [viesmaAssets()], build: { write: false } })).rejects.toThrow(
    /Unapproved media import/
  )
})

test('Vite skips unapproved public files and rejects additional emitted media', async () => {
  writeFileSync(join(root, 'index.html'), '<main>fixture</main>')
  mkdirSync(join(root, 'public'))
  cpSync(join(root, 'images/field.png'), join(root, 'public/unapproved.png'))
  const config = { configFile: false, root, logLevel: 'silent', build: { write: false } }
  const [result] = [await build({ ...config, plugins: [viesmaAssets()] })].flat()
  expect(result.output.some(({ fileName }) => fileName.endsWith('unapproved.png'))).toBe(false)
  await expect(
    build({
      ...config,
      plugins: [
        viesmaAssets(),
        {
          name: 'unapproved-media-fixture',
          buildStart() {
            this.emitFile({ type: 'asset', fileName: 'unapproved.png', source: 'fixture' })
          },
        },
      ],
    })
  ).rejects.toThrow(/Unapproved media output/)
})
