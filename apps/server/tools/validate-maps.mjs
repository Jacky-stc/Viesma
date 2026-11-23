import { listTiledTilesetSources, loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import process from 'node:process'

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error })
  }
}

async function readMap(file) {
  const extension = extname(file)
  if (extension !== '.tmj' && extension !== '.json') throw new Error(`${file}: expected a .tmj or .json map export`)
  const map = await readJson(file)
  try {
    const sources = listTiledTilesetSources(map)
    const tilesets = await Promise.all(sources.map(async (source) => [source, await readJson(resolve(dirname(file), source))]))
    return { mapId: basename(file, extension), map, tilesets: Object.fromEntries(tilesets) }
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error })
  }
}

try {
  let paths = process.argv.slice(2)
  if (paths[0] === '--') paths = paths.slice(1)
  const exports = await Promise.all(paths.map(readMap))
  const data = loadGrayboxGameData(exports.length === 0 ? undefined : exports)
  const mapContentHash = createHash('sha256').update(serializeMapManifest(data), 'utf8').digest('hex')
  process.stdout.write(`${JSON.stringify({ mapContentHash, maps: data.tiledMaps }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
