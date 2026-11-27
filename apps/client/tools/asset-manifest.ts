import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { crc32, inflateSync } from 'node:zlib'
import {
  beginnerStates,
  face01SpriteId,
  idleAttachmentIds,
  paperDollSlots,
  visualIds,
  type AssetAtlas,
  type AssetCatalog,
  type AtlasFrame,
  type AttachedFaceAsset,
  type BeginnerIdlePose,
  type IdleAttachment,
  type SpriteAsset,
  type SpriteClip,
  type TextureImageAsset,
} from '../src/rendering/assets/catalog.ts'

export const attributionPath = 'game-assets/attribution.txt'
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const maxDimension = 2048
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const licenses = new Map([
  ['CC0-1.0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  ['CC-BY-4.0', 'https://creativecommons.org/licenses/by/4.0/'],
])

type AssetErrorCode =
  | 'INVALID_MANIFEST'
  | 'DUPLICATE_ID'
  | 'MISSING_FILE'
  | 'INVALID_PATH'
  | 'INVALID_IMAGE'
  | 'INVALID_DIMENSIONS'
  | 'INVALID_REFERENCE'
  | 'UNAPPROVED_LICENSE'
  | 'MISSING_ATTRIBUTION'
  | 'DIGEST_MISMATCH'

export class AssetValidationError extends Error {
  readonly code: AssetErrorCode

  constructor(code: AssetErrorCode, path: string, message: string) {
    super(`${code} ${path}: ${message}`)
    this.code = code
    this.name = 'AssetValidationError'
  }
}

function fail(code: AssetErrorCode, path: string, message: string): never {
  throw new AssetValidationError(code, path, message)
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_MANIFEST', path, 'Expected an object')
  return input as Record<string, unknown>
}

function list(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input) || input.length === 0) fail('INVALID_MANIFEST', path, 'Expected a nonempty array')
  return input
}

function nonempty(input: unknown, path: string, code: AssetErrorCode = 'INVALID_MANIFEST'): string {
  if (typeof input !== 'string' || !input.trim()) fail(code, path, 'Expected nonempty text')
  return input.trim()
}

function assetId(input: unknown, path: string) {
  if (typeof input !== 'string' || !idPattern.test(input)) fail('INVALID_MANIFEST', path, 'Expected lowercase kebab-case ID')
  return input
}

function integer(input: unknown, path: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) {
    fail('INVALID_DIMENSIONS', path, `Expected integer from ${min} to ${max}`)
  }
  return input
}

export function localPath(input: unknown, path: string): string {
  if (typeof input !== 'string' || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(input)) {
    fail('INVALID_PATH', path, 'Expected a lowercase relative file path')
  }
  return input
}

export function readLocalFile(root: string, file: string): Buffer | undefined {
  let target = resolve(root)
  for (const part of localPath(file, file).split('/')) {
    target = resolve(target, part)
    const stat = lstatSync(target, { throwIfNoEntry: false })
    if (!stat) return undefined
    if (stat.isSymbolicLink()) fail('INVALID_PATH', file, 'Symbolic links are not supported in asset sources')
    if (!stat.isDirectory() && !stat.isFile()) fail('INVALID_PATH', file, 'Expected a regular file')
  }
  if (!lstatSync(target).isFile()) fail('INVALID_PATH', file, 'Expected a regular file')
  return readFileSync(target)
}

function requiredFile(root: string, file: string) {
  const data = readLocalFile(root, file)
  if (!data?.length) fail('MISSING_FILE', file, 'Expected a nonempty file')
  return data
}

export function readJson(input: Buffer, path: string): unknown {
  try {
    return JSON.parse(input.toString('utf8'))
  } catch {
    return fail('INVALID_MANIFEST', path, 'Invalid JSON')
  }
}

function sourceUrl(input: unknown, path: string) {
  const value = nonempty(input, path, 'UNAPPROVED_LICENSE')
  if (!URL.canParse(value)) fail('UNAPPROVED_LICENSE', path, 'Expected an HTTPS source URL')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) fail('UNAPPROVED_LICENSE', path, 'Expected an HTTPS source URL')
  return url.href
}

function readRights(input: unknown, root: string, path: string) {
  const { kind, creator, license, evidence, attribution, source, changes, generator } = record(input, path)
  if (kind !== 'original' && kind !== 'licensed') fail('UNAPPROVED_LICENSE', path, 'Expected original or licensed provenance')
  const author = nonempty(creator, `${path}.creator`, 'UNAPPROVED_LICENSE')
  const evidencePath = localPath(evidence, `${path}.evidence`)
  if (!evidencePath.startsWith('provenance/') || !/\.(md|txt)$/.test(evidencePath)) {
    fail('INVALID_PATH', path, 'Put evidence under provenance/ as Markdown or text')
  }
  if (!requiredFile(root, evidencePath).toString('utf8').trim()) fail('UNAPPROVED_LICENSE', path, 'Evidence is empty')
  const notice = attribution === undefined ? undefined : nonempty(attribution, `${path}.attribution`, 'MISSING_ATTRIBUTION')
  const url = source === undefined ? undefined : sourceUrl(source, `${path}.source`)
  let generated = ''
  if (generator !== undefined) {
    const generatorPath = localPath(generator, `${path}.generator`)
    requiredFile(root, generatorPath)
    generated = `\nGenerator: ${generatorPath}`
  }
  const evidenceLine = `\nEvidence: ${evidencePath}${generated}${notice ? `\nCredit: ${notice}` : ''}`
  if (kind === 'original') {
    if (license !== 'project-owned') fail('UNAPPROVED_LICENSE', path, 'Expected project-owned rights')
    return `Creator: ${author}\nRights: ${license}${url ? `\nSource: ${url}` : ''}${evidenceLine}`
  }
  const licenseUrl = typeof license === 'string' ? licenses.get(license) : undefined
  if (!licenseUrl) fail('UNAPPROVED_LICENSE', `${path}.license`, 'License is outside the project allowlist')
  if (!url) fail('UNAPPROVED_LICENSE', `${path}.source`, 'Licensed assets require an HTTPS source URL')
  if (license === 'CC-BY-4.0' && !notice) fail('MISSING_ATTRIBUTION', `${path}.attribution`, 'CC BY requires attribution')
  const changeNotice = nonempty(changes, `${path}.changes`, 'MISSING_ATTRIBUTION')
  return `Creator: ${author}\nSource: ${url}\nLicense: ${license} (${licenseUrl})\nChanges: ${changeNotice}${evidenceLine}`
}

function validatePng(data: Buffer, width: number, height: number, path: string) {
  if (
    data.length < 45 ||
    !data.subarray(0, 8).equals(pngSignature) ||
    data.readUInt32BE(8) !== 13 ||
    data.toString('ascii', 12, 16) !== 'IHDR' ||
    crc32(data.subarray(12, 29)) !== data.readUInt32BE(29)
  )
    fail('INVALID_IMAGE', path, 'Expected PNG with an IHDR chunk')
  if (data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) {
    fail('INVALID_DIMENSIONS', path, `PNG dimensions disagree with manifest (${width} × ${height})`)
  }
  const channels = data[25] === 6 ? 4 : data[25] === 2 ? 3 : 0
  if (data[24] !== 8 || channels === 0 || data[26] !== 0 || data[27] !== 0 || data[28] !== 0) {
    fail('INVALID_IMAGE', path, 'Expected 8-bit, non-interlaced RGB or RGBA')
  }
  const chunks: Buffer[] = []
  for (let offset = 33; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('ascii', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > data.length || type === 'acTL' || type === 'IHDR') break
    if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) {
      fail('INVALID_IMAGE', path, `Invalid ${type} checksum`)
    }
    if (type === 'IDAT') chunks.push(data.subarray(offset + 8, end - 4))
    if (type === 'IEND' && length === 0 && end === data.length && chunks.length > 0) {
      const rowBytes = 1 + channels * width
      let pixels: Buffer
      try {
        pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: rowBytes * height })
      } catch {
        return fail('INVALID_IMAGE', path, 'Invalid compressed pixel data')
      }
      if (pixels.length !== rowBytes * height) fail('INVALID_IMAGE', path, 'Incorrect number of pixel rows')
      for (let row = 0; row < height; row++) {
        if (pixels.readUInt8(row * rowBytes) > 4) fail('INVALID_IMAGE', path, 'Invalid PNG row filter')
      }
      return
    }
    offset = end
  }
  fail('INVALID_IMAGE', path, 'Incomplete or unsupported PNG')
}

function readFrame(input: unknown, path: string, width: number, height: number): AtlasFrame {
  const fields = record(input, path)
  const x = integer(fields.x, `${path}.x`, 0, width - 1)
  const y = integer(fields.y, `${path}.y`, 0, height - 1)
  return {
    x,
    y,
    width: integer(fields.width, `${path}.width`, 1, width - x),
    height: integer(fields.height, `${path}.height`, 1, height - y),
  }
}

function readIdlePose(input: unknown, path: string, clip: SpriteClip | undefined, atlasId: string): BeginnerIdlePose {
  const data = record(input, path)
  const { width, height } = record(data.originalSizePx, path)
  const pivot = record(data.pivotPx, path)
  if (
    data.schemaVersion !== 1 ||
    data.poseSetId !== 'beginner' ||
    data.poseVersion !== 1 ||
    data.sourceFacing !== 'left' ||
    width !== 384 ||
    height !== 384 ||
    pivot.x !== 192 ||
    pivot.y !== 320 ||
    data.worldUnitsPerPixel !== 0.3125
  )
    fail('INVALID_MANIFEST', path, 'Expected the Beginner v1 canvas, scale, facing and pivot')
  const idle = record(record(data.clips, path).idle, path)
  const frames = list(idle.frames, path)
  if (idle.loop !== true || !clip?.loop || clip.ticksPerFrame !== 6 || frames.length !== 4 || clip.frames.length !== frames.length) {
    fail('INVALID_MANIFEST', path, 'Expected four looping Idle frames at six ticks each')
  }
  return {
    pivotPx: { x: pivot.x, y: pivot.y },
    worldUnitsPerPixel: data.worldUnitsPerPixel,
    ticksPerFrame: clip.ticksPerFrame,
    frames: frames.map((input, index) => {
      const framePath = `${path}.clips.idle.frames[${index}]`
      const frame = record(input, framePath)
      const order = list(frame.drawOrder, framePath)
      const drawOrder = order.map((slot) => {
        const known = paperDollSlots.find((id) => id === slot)
        if (known === undefined) fail('INVALID_MANIFEST', framePath, 'Unknown Paper Doll slot')
        return known
      })
      if (
        frame.index !== index ||
        frame.durationTicks !== clip.ticksPerFrame ||
        !drawOrder.includes('baseBody') ||
        new Set(drawOrder).size !== drawOrder.length
      ) {
        fail('INVALID_MANIFEST', framePath, 'Invalid Idle index, duration or draw order')
      }
      const layer = record(record(frame.layers, framePath).baseBody, framePath)
      const rect = record(layer.rectPx, framePath)
      const offset = record(layer.offsetPx, framePath)
      const expected = clip.frames[index]
      if (
        layer.atlasId !== atlasId ||
        offset.x !== 8 ||
        offset.y !== 8 ||
        rect.x !== index * 384 + offset.x ||
        rect.y !== offset.y ||
        rect.width !== width - 2 * offset.x ||
        rect.height !== height - 2 * offset.y ||
        !expected ||
        expected.x !== rect.x ||
        expected.y !== rect.y ||
        expected.width !== rect.width ||
        expected.height !== rect.height
      ) {
        fail('INVALID_REFERENCE', framePath, 'Idle pose rect must match its inset atlas frame')
      }
      const points = record(frame.attachments, framePath)
      function point(id: (typeof idleAttachmentIds)[number]): IdleAttachment {
        const { x, y, rotationDeg } = record(points[id], `${framePath}.attachments.${id}`)
        if (
          typeof x !== 'number' ||
          !Number.isFinite(x) ||
          x < 0 ||
          x > 384 ||
          typeof y !== 'number' ||
          !Number.isFinite(y) ||
          y < 0 ||
          y > 384 ||
          typeof rotationDeg !== 'number' ||
          !Number.isFinite(rotationDeg) ||
          rotationDeg < 0 ||
          rotationDeg >= 360
        ) {
          fail('INVALID_MANIFEST', framePath, `Invalid attachment ${id}`)
        }
        return { x, y, rotationDeg }
      }
      const foot = point('foot')
      const nearSole = point('nearSole')
      const farSole = point('farSole')
      if (foot.x !== pivot.x || [foot, nearSole, farSole].some(({ y }) => y !== pivot.y)) {
        fail('INVALID_MANIFEST', framePath, 'Invalid foot attachments')
      }
      return {
        offsetPx: { x: offset.x, y: offset.y },
        drawOrder,
        attachments: {
          head: point('head'),
          face: point('face'),
          torso: point('torso'),
          mainHand: point('mainHand'),
          offHand: point('offHand'),
          foot,
          nearSole,
          farSole,
        },
      }
    }),
  }
}

function readAttachedFace(input: unknown, path: string, clips: Readonly<Record<string, SpriteClip>>): AttachedFaceAsset {
  const fields = record(input, path)
  const clip = clips.idle
  const frame = clip?.frames[0]
  if (
    fields.poseSetId !== 'beginner' ||
    fields.poseVersion !== 1 ||
    !frame ||
    clip.frames.length !== 1 ||
    clip.loop ||
    clip.ticksPerFrame !== 1 ||
    Object.keys(clips).length !== 1
  ) {
    fail('INVALID_MANIFEST', path, 'Expected one static frame compatible with the Beginner v1 pose')
  }
  const offset = record(fields.offsetPx, path)
  const origin = record(fields.originPx, path)
  const offsetPx = {
    x: integer(offset.x, path, 8, 384 - 8 - frame.width),
    y: integer(offset.y, path, 8, 384 - 8 - frame.height),
  }
  if (typeof origin.x !== 'number' || !Number.isFinite(origin.x) || typeof origin.y !== 'number' || !Number.isFinite(origin.y)) {
    fail('INVALID_MANIFEST', path, 'Expected a finite origin in trimmed sprite pixels')
  }
  const calibrationPath = `${path}.defaultCalibration`
  const { xPx, yPx, scale } = record(fields.defaultCalibration, calibrationPath)
  if (
    typeof xPx !== 'number' ||
    Math.abs(xPx) > 32 ||
    !Number.isInteger(xPx * 2) ||
    typeof yPx !== 'number' ||
    Math.abs(yPx) > 32 ||
    !Number.isInteger(yPx * 2) ||
    typeof scale !== 'number' ||
    !Number.isFinite(scale) ||
    scale < 0.5 ||
    scale > 1.5
  ) {
    fail('INVALID_MANIFEST', calibrationPath, 'Expected offsets in half logical pixels and a supported uniform scale')
  }
  return { offsetPx, originPx: { x: origin.x, y: origin.y }, defaultCalibration: { xPx, yPx, scale } }
}

function readSprite(input: unknown, path: string, width: number, height: number, atlasId: string): SpriteAsset {
  const fields = record(input, path)
  const id = assetId(fields.id, `${path}.id`)
  const type = fields.type
  if (type !== 'player' && type !== 'monster' && type !== 'tile' && type !== 'npc' && type !== 'loot') {
    fail('INVALID_MANIFEST', path, 'Unknown sprite type')
  }
  const clips = Object.fromEntries(
    Object.entries(record(fields.clips, `${path}.clips`))
      .sort(([a], [b]) => compare(a, b))
      .map(([key, input]) => {
        const clipPath = `${path}.clips.${assetId(key, path)}`
        const value = record(input, clipPath)
        if (typeof value.loop !== 'boolean') fail('INVALID_MANIFEST', clipPath, 'Expected a loop flag')
        const frames = list(value.frames, `${clipPath}.frames`).map((frame, index) =>
          readFrame(frame, `${clipPath}.frames[${index}]`, width, height)
        )
        return [key, { frames, ticksPerFrame: integer(value.ticksPerFrame, `${clipPath}.ticksPerFrame`, 1, 300), loop: value.loop }]
      })
  )
  if (Object.keys(clips).length === 0) fail('INVALID_MANIFEST', path, 'Expected at least one clip')
  const idlePose = id === visualIds.beginnerIdle ? readIdlePose(fields.idlePose, `${path}.idlePose`, clips.idle, atlasId) : undefined
  const attachedFace = id === face01SpriteId ? readAttachedFace(fields.attachedFace, `${path}.attachedFace`, clips) : undefined
  return {
    id,
    type,
    renderWidth: integer(fields.renderWidth, `${path}.renderWidth`, 1, maxDimension),
    renderHeight: integer(fields.renderHeight, `${path}.renderHeight`, 1, maxDimension),
    clips,
    ...(idlePose && { idlePose }),
    ...(attachedFace && { attachedFace }),
  }
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function unique(keys: Set<string>, value: string, path: string) {
  if (keys.has(value)) fail('DUPLICATE_ID', path, `Duplicate value "${value}"`)
  keys.add(value)
}

function validateCoverage(atlases: readonly AssetAtlas[]) {
  const sprites = new Map(atlases.flatMap(({ sprites }) => sprites.map((sprite) => [sprite.id, sprite] as const)))
  const face = sprites.get(face01SpriteId)?.attachedFace
  if (face) {
    const pose = sprites.get(visualIds.beginnerIdle)?.idlePose
    const anchor = pose?.frames[0]?.attachments.face
    if (
      !anchor ||
      !pose?.frames.every(({ drawOrder }) => drawOrder.includes('face')) ||
      Math.abs(face.offsetPx.x + face.originPx.x - anchor.x) > 0.001 ||
      Math.abs(face.offsetPx.y + face.originPx.y - anchor.y) > 0.001
    ) {
      fail('INVALID_REFERENCE', face01SpriteId, 'Expected the face origin and slot to match the Beginner Idle pose')
    }
  }
  const required = [
    { id: visualIds.beginner, type: 'player', clips: beginnerStates },
    { id: visualIds.guide, type: 'npc', clips: ['idle'] },
    { id: visualIds.trailTile, type: 'tile', clips: ['idle'] },
    { id: visualIds.loot, type: 'loot', clips: ['idle'] },
    ...Object.values(visualIds.monsters).map((id) => ({ id, type: 'monster', clips: ['idle'] })),
  ]
  for (const { id, type, clips } of required) {
    const sprite = sprites.get(id)
    if (sprite?.type !== type) fail('INVALID_REFERENCE', id, `Expected a registered ${type} sprite`)
    for (const clip of clips) {
      if (!Object.hasOwn(sprite.clips, clip)) fail('INVALID_REFERENCE', id, `Missing animation "${clip}"`)
    }
  }
}

export function buildAssetCatalog(input: unknown, root: string, development = false, ...experimentalAtlases: unknown[]) {
  const manifest = record(input, 'manifest')
  if (manifest.schemaVersion !== 1) fail('INVALID_MANIFEST', 'schemaVersion', 'Expected schema version 1')
  const definitions = [...list(manifest.atlases, 'atlases')]
  const productionAtlasCount = definitions.length
  for (const experimentalAtlas of experimentalAtlases) {
    const extra = record(experimentalAtlas, 'experimental atlas manifest')
    if (extra.schemaVersion !== 1) fail('INVALID_MANIFEST', 'experimental atlas schemaVersion', 'Expected schema version 1')
    definitions.push(...list(extra.atlases, 'experimental atlases'))
  }
  const ids = new Set<string>()
  const sources = new Set<string>()
  const files = new Map<string, Buffer>()
  const entries = definitions
    .map((input, i) => {
      const path = `atlases[${i}]`
      const value = record(input, path)
      const id = assetId(value.id, `${path}.id`)
      unique(ids, id, path)
      if (value.type !== 'atlas') fail('INVALID_MANIFEST', path, 'Expected an atlas')
      const source = localPath(value.source, `${path}.source`)
      if (!source.startsWith('images/') || !source.endsWith('.png')) fail('INVALID_PATH', path, 'Expected images/*.png')
      unique(sources, source, path)
      if (value.output !== `game-assets/${id}.png`) fail('INVALID_PATH', path, 'Output must match the atlas ID')
      if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('INVALID_MANIFEST', path, 'Expected SHA-256')
      if (value.optionalInDevelopment !== undefined && typeof value.optionalInDevelopment !== 'boolean') {
        fail('INVALID_MANIFEST', path, 'Expected a boolean optionalInDevelopment flag')
      }
      const width = integer(value.width, `${path}.width`, 1, maxDimension)
      const height = integer(value.height, `${path}.height`, 1, maxDimension)
      const credit = readRights(value.rights, root, `${path}.rights`)
      const sprites = list(value.sprites, `${path}.sprites`)
        .map((sprite, index) => {
          const entry = readSprite(sprite, `${path}.sprites[${index}]`, width, height, id)
          if (entry.idlePose && (i < productionAtlasCount || value.optionalInDevelopment !== true || width !== 1536 || height !== 384)) {
            fail('INVALID_MANIFEST', path, 'The Beginner Idle sheet must be a 1536 × 384 optional development atlas')
          }
          if (entry.attachedFace && (i < productionAtlasCount || value.optionalInDevelopment !== true || entry.type !== 'player')) {
            fail('INVALID_MANIFEST', path, 'Face 01 must be an optional development player atlas')
          }
          unique(ids, entry.id, path)
          return entry
        })
        .sort((a, b) => compare(a.id, b.id))
      const output = `game-assets/${id}.${value.sha256.slice(0, 16)}.png`
      const bytes = readLocalFile(root, source)
      if (bytes) {
        validatePng(bytes, width, height, source)
        if (digest(bytes) !== value.sha256) fail('DIGEST_MISMATCH', source, 'Bytes do not match the reviewed manifest')
      } else if (!development || value.optionalInDevelopment !== true) {
        fail('MISSING_FILE', source, 'Missing atlas PNG')
      }
      return { atlas: { id, width, height, output, sprites }, bytes, credit }
    })
    .sort((a, b) => compare(a.atlas.id, b.atlas.id))
  const catalog: AssetCatalog = { schemaVersion: 1, atlases: entries.map(({ atlas }) => atlas) }
  validateCoverage(catalog.atlases)
  for (const { atlas, bytes } of entries) {
    if (bytes) files.set(atlas.output, bytes)
  }
  files.set(
    attributionPath,
    Buffer.from(
      entries.map(({ atlas, credit }) => `[${atlas.id}] ${atlas.sprites.map(({ id }) => id).join(', ')}\n${credit}`).join('\n\n') + '\n'
    )
  )
  return { catalog, files }
}

function digest(data: Buffer) {
  return createHash('sha256').update(data).digest('hex')
}

export function addExperimentalParallax(
  assets: ReturnType<typeof buildAssetCatalog>,
  input: unknown,
  sourceRoot: string,
  rightsRoot: string,
  allowMissing: boolean
) {
  const manifest = record(input, 'experimental parallax manifest')
  if (manifest.schemaVersion !== 1) fail('INVALID_MANIFEST', 'schemaVersion', 'Expected schema version 1')
  const ids = new Set(assets.catalog.atlases.flatMap((atlas) => [atlas.id, ...atlas.sprites.map(({ id }) => id)]))
  const sources = new Set<string>()
  const credits: string[] = []
  const images: TextureImageAsset[] = []
  const credit = readRights(manifest.rights, rightsRoot, 'rights')
  for (const [index, raw] of list(manifest.images, 'images').entries()) {
    const path = `images[${index}]`
    const value = record(raw, path)
    const id = assetId(value.id, `${path}.id`)
    unique(ids, id, path)
    const source = localPath(value.source, `${path}.source`)
    if (!source.endsWith('.png')) fail('INVALID_PATH', path, 'Expected a source PNG')
    unique(sources, source, path)
    if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('INVALID_MANIFEST', path, 'Expected SHA-256')
    const width = integer(value.width, `${path}.width`, 1, 4096)
    const height = integer(value.height, `${path}.height`, 1, 4096)
    const bytes = readLocalFile(sourceRoot, source)
    if (!bytes) {
      if (!allowMissing) fail('MISSING_FILE', source, 'Missing parallax PNG')
      continue
    }
    validatePng(bytes, width, height, source)
    if (digest(bytes) !== value.sha256) fail('DIGEST_MISMATCH', source, 'Bytes do not match the reviewed manifest')
    const output = `game-assets/${id}.${value.sha256.slice(0, 16)}.png`
    assets.files.set(output, bytes)
    images.push({ id, width, height, output })
    credits.push(`[${id}]\n${credit}`)
  }
  if (credits.length) {
    assets.files.set(attributionPath, Buffer.from(`${assets.files.get(attributionPath)?.toString() ?? ''}\n${credits.join('\n\n')}\n`))
  }
  return { catalog: { ...assets.catalog, experimentalParallax: images }, files: assets.files }
}

export function validateTiledAssetReferences(mapsRoot: string, mapFiles: readonly string[], assets: ReturnType<typeof buildAssetCatalog>) {
  const tiles = assets.catalog.atlases.filter(({ sprites }) => sprites.some(({ type }) => type === 'tile'))
  for (const file of mapFiles) {
    const map = record(readJson(requiredFile(mapsRoot, file), file), file)
    if (!Array.isArray(map.tilesets)) fail('INVALID_REFERENCE', file, 'Expected Tiled tileset references')
    for (const input of map.tilesets) {
      const path = localPath(record(input, file).source, file)
      if (!/\.(tsj|json)$/.test(path)) fail('INVALID_REFERENCE', file, 'Expected an external Tiled JSON tileset')
      const source = dirname(file) === '.' ? path : `${dirname(file).replaceAll('\\', '/')}/${path}`
      const tileset = record(readJson(requiredFile(mapsRoot, source), source), source)
      const image = localPath(tileset.image, source)
      const directory = dirname(source).replaceAll('\\', '/')
      const bytes = requiredFile(mapsRoot, directory === '.' ? image : `${directory}/${image}`)
      const approved = tiles.find(({ output }) => assets.files.get(output)?.equals(bytes))
      if (!approved) fail('INVALID_REFERENCE', source, `Unregistered Tiled image "${image}"`)
      if (tileset.imagewidth !== approved.width || tileset.imageheight !== approved.height) {
        fail('INVALID_DIMENSIONS', source, 'Tiled image dimensions disagree with the approved atlas')
      }
    }
  }
}
