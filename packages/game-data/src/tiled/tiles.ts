import { array, compareIds, fields, integer, invalid, name, object } from '../validation.js'
import { defaultOnly, relativeAssetPath, tiledRecord, tiledVersion, unsupported } from './format.js'
import type { NormalizedTile, NormalizedTileset } from './types.js'

const maxGid = 0x0fffffff

interface TilesetReference {
  readonly firstGid: number
  readonly source: string
  readonly path: string
}

function parseReferences(input: unknown, path: string): TilesetReference[] {
  const sources = new Set<string>()
  return array(input, path, (entry, entryPath) => {
    const value = object(entry, entryPath)
    if (!Object.hasOwn(value, 'source')) unsupported(`${entryPath}.source`, 'Use an external JSON tileset')
    fields(value, entryPath, ['firstgid', 'source'])
    const source = relativeAssetPath(value.source, `${entryPath}.source`)
    if (!/\.(tsj|json)$/.test(source)) unsupported(`${entryPath}.source`, 'Expected a .tsj or .json tileset')
    if (sources.has(source)) invalid('DUPLICATE_ID', `${entryPath}.source`, `Duplicate tileset "${source}"`)
    sources.add(source)
    return { firstGid: integer(value.firstgid, `${entryPath}.firstgid`, 1, maxGid), source, path: entryPath }
  })
}

export function listTiledTilesetSources(input: unknown): readonly string[] {
  return parseReferences(object(input, 'map').tilesets, 'map.tilesets').map(({ source }) => source)
}

function parseTileset(input: unknown, path: string, source: string, tileSize: number): NormalizedTileset {
  const value = tiledRecord(
    input,
    path,
    ['type', 'version', 'tiledversion', 'name', 'image', 'imagewidth', 'imageheight', 'tilewidth', 'tileheight', 'columns', 'tilecount'],
    ['margin', 'spacing', 'class', 'objectalignment', 'tilerendersize', 'fillmode']
  )
  tiledVersion(value, path)
  if (value.type !== 'tileset') unsupported(`${path}.type`, 'Expected an external atlas tileset')
  defaultOnly(value.class, `${path}.class`, '')
  defaultOnly(value.objectalignment, `${path}.objectalignment`, 'unspecified')
  defaultOnly(value.tilerendersize, `${path}.tilerendersize`, 'tile')
  defaultOnly(value.fillmode, `${path}.fillmode`, 'stretch')
  name(value.name, `${path}.name`)
  integer(value.tilewidth, `${path}.tilewidth`, tileSize, tileSize)
  integer(value.tileheight, `${path}.tileheight`, tileSize, tileSize)
  const image = relativeAssetPath(value.image, `${path}.image`)
  const imageWidth = integer(value.imagewidth, `${path}.imagewidth`, 1)
  const imageHeight = integer(value.imageheight, `${path}.imageheight`, 1)
  const columns = integer(value.columns, `${path}.columns`, 1, maxGid)
  const tileCount = integer(value.tilecount, `${path}.tilecount`, 1, maxGid)
  const margin = value.margin === undefined ? 0 : integer(value.margin, `${path}.margin`)
  const spacing = value.spacing === undefined ? 0 : integer(value.spacing, `${path}.spacing`)
  const widthCells = Math.floor((imageWidth - 2 * margin + spacing) / (tileSize + spacing))
  const heightCells = Math.floor((imageHeight - 2 * margin + spacing) / (tileSize + spacing))
  if (columns !== widthCells) invalid('INVALID_VALUE', `${path}.columns`, 'Column count disagrees with image dimensions')
  if (heightCells < 1 || heightCells !== tileCount / columns) {
    invalid('INVALID_VALUE', `${path}.tilecount`, 'Tile count disagrees with the atlas grid')
  }
  return { source, image, imageWidth, imageHeight, columns, tileCount, margin, spacing }
}

export function resolveTilesets(input: unknown, files: unknown, path: string, tileSize: number) {
  const references = parseReferences(input, `${path}.map.tilesets`).sort((a, b) => a.firstGid - b.firstGid)
  const definitions = object(files, `${path}.tilesets`)
  let previousEnd = 0
  const ranges = references.map(({ firstGid, source, path: referencePath }, index) => {
    if (!Object.hasOwn(definitions, source)) {
      invalid('UNKNOWN_REFERENCE', `${referencePath}.source`, `Missing external tileset "${source}"`)
    }
    const tileset = parseTileset(definitions[source], `${path}.tilesets[${JSON.stringify(source)}]`, source, tileSize)
    if ((index === 0 && firstGid !== 1) || firstGid <= previousEnd || firstGid + tileset.tileCount - 1 > maxGid) {
      invalid('INVALID_REFERENCE', `${referencePath}.firstgid`, 'Tileset GID ranges must start at 1, fit and never overlap')
    }
    previousEnd = firstGid + tileset.tileCount - 1
    return { firstGid, endGid: previousEnd, tileset }
  })
  return {
    tilesets: ranges.map(({ tileset }) => tileset).sort((a, b) => compareIds(a.source, b.source)),
    decode(input: unknown, cellPath: string): NormalizedTile | null {
      const raw = integer(input, cellPath, 0, 0xffffffff)
      if (raw === 0) return null
      // Tiled 可能保留曾使用六角格的第 29 位。Orthogonal 只保留 H、V、D。
      const gid = raw & maxGid
      const range = ranges.find(({ firstGid, endGid }) => gid >= firstGid && gid <= endGid)
      if (!range) invalid('UNKNOWN_REFERENCE', cellPath, `GID ${gid} does not identify a tile`)
      return {
        tileset: range.tileset.source,
        tileId: gid - range.firstGid,
        flipHorizontal: (raw & 0x80000000) !== 0,
        flipVertical: (raw & 0x40000000) !== 0,
        flipDiagonal: (raw & 0x20000000) !== 0,
      }
    },
  }
}
