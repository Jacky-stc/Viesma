import { Rectangle, Texture, TextureSource } from 'pixi.js'
import { expect, test, vi } from 'vitest'
import { createAtlasScope } from '../src/rendering/assets/atlas-scope.ts'
import { beginnerStates, face01SpriteId, indexSprites, resolveFrame, visualIds } from '../src/rendering/assets/catalog.ts'
import { createPaperDollView, diagnosticSpriteId } from '../src/rendering/assets/paper-doll-view.ts'
import { createBeginnerView } from '../src/rendering/assets/sprite-views.ts'
import { characterPreviewHeights, defaultCharacterPreview } from '../src/rendering/character-preview.ts'
import { loadProjectAssets } from '../tools/asset-project.ts'

const sprites = indexSprites(loadProjectAssets().catalog)

test('Beginner has a frame for each presentation state and supports loops and held frames', () => {
  const { clips } = sprites.get(visualIds.beginner).sprite
  expect(beginnerStates.map((state) => resolveFrame(clips[state], 0))).not.toContain(undefined)
  expect(resolveFrame(clips.run, 4)).toBe(clips.run.frames[1])
  expect(resolveFrame(clips.run, 8)).toBe(clips.run.frames[0])
  expect(resolveFrame(clips.attack, 40)).toBe(clips.attack.frames[1])
})

test('a scope loads each atlas once and resolves only its registered sprites and animations', async () => {
  const resource = { frame: vi.fn(() => Texture.WHITE), destroy: vi.fn() }
  const load = vi.fn(async () => resource)
  const scope = createAtlasScope(sprites, '/game/', load)
  scope.prepare('slime')
  scope.prepare('mushroom')
  scope.prepare('unregistered')
  expect(scope.resolve('slime', 'idle', 0)).toBeUndefined()
  await Promise.resolve()
  expect(load).toHaveBeenCalledExactlyOnceWith(sprites.get('slime').atlas, '/game/', expect.any(globalThis.AbortSignal))
  expect(scope.resolve('slime', 'idle', 0)).toEqual({ texture: Texture.WHITE, width: 32, height: 32 })
  expect(scope.resolve('slime', 'missing', 0)).toBeUndefined()
  expect(scope.resolve('unregistered', 'idle', 0)).toBeUndefined()
  scope.destroy()
  scope.destroy()
  expect(resource.destroy).toHaveBeenCalledTimes(1)
  expect(scope.resolve('slime', 'idle', 0)).toBeUndefined()
})

test('a bitmap returned after transfer is destroyed without becoming visible', async () => {
  let complete
  const load = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const scope = createAtlasScope(sprites, '/', load)
  scope.prepare('slime')
  scope.destroy()
  expect(load.mock.calls[0][2].aborted).toBe(true)
  const resource = { frame: vi.fn(), destroy: vi.fn() }
  complete(resource)
  await Promise.resolve()
  expect(resource.destroy).toHaveBeenCalledTimes(1)
  expect(resource.frame).not.toHaveBeenCalled()
  expect(scope.resolve('slime', 'idle', 0)).toBeUndefined()
})

test('an unavailable atlas leaves the existing Beginner vector fallback visible at the body feet', async () => {
  const load = vi.fn(async () => {
    throw new Error('offline')
  })
  const scope = createAtlasScope(sprites, '/', load)
  const view = createBeginnerView({ width: 24, height: 48 }, scope)
  const frame = { state: 'run', position: { x: 100, y: 250 }, facing: 'left', visualTick: 8 }
  view.draw(frame)
  expect(view.root.children.map(({ visible }) => visible)).toEqual([true, false])
  await Promise.resolve()
  view.draw(frame)
  const [fallback, sprite] = view.root.children
  expect(fallback.visible).toBe(true)
  expect(sprite.visible).toBe(false)
  expect({ x: fallback.x, y: fallback.y, facing: fallback.scale.x }).toEqual({ x: 112, y: 298, facing: -1 })
  expect(load).toHaveBeenCalledTimes(1)
  expect(frame.position).toEqual({ x: 100, y: 250 })
  view.root.destroy({ children: true, context: true })
  scope.destroy()
})

test.each([
  [visualIds.beginnerStatic, 64],
  [visualIds.beginnerBaseBody, 80],
])('%s is development-only and declares a single frame at height %i', (id, height) => {
  const { catalog, files } = loadProjectAssets(false, true)
  const { atlas, sprite } = indexSprites(catalog).get(id)
  expect(atlas.height).toBe(256)
  expect(sprite.renderHeight).toBe(height)
  expect(sprite.clips).toMatchObject({ idle: { frames: [{ x: 0, y: 0, width: atlas.width, height: atlas.height }] } })
  expect(Object.keys(sprite.clips)).toEqual(['idle'])
  expect(files.has(atlas.output)).toBe(true)
  expect(sprites.has(id)).toBe(false)
  expect(loadProjectAssets().files.has(atlas.output)).toBe(false)
})

test.each([
  ['base-body', visualIds.beginnerBaseBody],
  ['character-master', visualIds.beginnerStatic],
])('local and peer views share the %s frame, preserve its proportions and mirror around the body feet', async (mode, id) => {
  const catalog = indexSprites(loadProjectAssets(false, true).catalog)
  const { atlas } = catalog.get(id)
  const texture = new Texture({ source: new TextureSource({ width: atlas.width, height: atlas.height }) })
  const legacy = createAtlasScope(sprites, '/', async () => ({ frame: () => Texture.WHITE, destroy: () => {} }))
  const load = vi.fn(async () => ({ frame: () => texture, destroy: () => texture.destroy(true) }))
  const experiment = createAtlasScope(catalog, '/', load, 'linear')
  const body = { width: 24, height: 48 }
  const local = createBeginnerView(body, legacy, experiment)
  const peer = createBeginnerView(body, legacy, experiment)
  const frame = { state: 'idle', position: { x: 100, y: 250 }, facing: 'right', visualTick: 0 }
  const preview = { ...defaultCharacterPreview, mode, showCollision: true, showFootAnchor: true }

  try {
    experiment.prepare(id)
    await Promise.resolve()
    for (const state of beginnerStates) {
      for (const height of characterPreviewHeights) {
        local.draw({ ...frame, state }, { ...preview, height })
        peer.draw({ ...frame, state, facing: 'left' }, { ...preview, height })
        const [fallback, sprite, collision, foot] = local.root.children
        expect(fallback.visible).toBe(false)
        expect(sprite.texture).toBe(texture)
        expect(sprite.anchor).toMatchObject({ x: 0.5, y: 1 })
        expect(sprite.scale.x).toBe(-height / atlas.height)
        expect(sprite.width).toBeCloseTo((height * atlas.width) / atlas.height)
        expect(sprite.height).toBeCloseTo(height)
        for (const view of [sprite, collision, foot]) expect(view.position).toMatchObject({ x: 112, y: 298 })
        expect(peer.root.children[1].texture).toBe(texture)
        expect(peer.root.children[1].scale.x).toBe(height / atlas.height)
      }
    }
    local.draw(frame, preview, 'left')
    expect(local.root.children[1].scale.x).toBe(preview.height / atlas.height)
    local.draw(frame, { ...defaultCharacterPreview, mode: 'legacy' })
    const [, sprite, collision, foot] = local.root.children
    expect(sprite.texture).toBe(Texture.WHITE)
    expect(sprite.width).toBe(64)
    expect(sprite.height).toBe(56)
    expect(sprite.scale.x).toBeGreaterThan(0)
    expect([collision.visible, foot.visible]).toEqual([false, false])
    expect(load).toHaveBeenCalledTimes(1)
  } finally {
    for (const { root } of [local, peer]) root.destroy({ children: true, context: true })
    experiment.destroy()
    legacy.destroy()
  }
  expect(texture.destroyed).toBe(true)
})

test('the development Idle sheet prewarms shared frames and local and peer playback keep separate phases', async () => {
  const { catalog, files } = loadProjectAssets(false, true)
  const experimentSprites = indexSprites(catalog)
  const { atlas, sprite: definition } = experimentSprites.get(visualIds.beginnerIdle)
  const { idlePose, clips } = definition
  expect({ width: atlas.width, height: atlas.height, frames: clips.idle.frames.length }).toEqual({ width: 1536, height: 384, frames: 4 })
  expect(files.has(atlas.output)).toBe(true)
  expect(sprites.has(visualIds.beginnerIdle)).toBe(false)
  expect(loadProjectAssets().files.has(atlas.output)).toBe(false)
  const { head, foot } = idlePose.frames[0].attachments
  expect(idlePose.frames.map(({ attachments }) => attachments.head.y - head.y)).toEqual([0, -1, -3, -1])
  expect(idlePose.frames.map(({ attachments }) => attachments.foot)).toEqual([foot, foot, foot, foot])
  const source = new TextureSource({ width: atlas.width, height: atlas.height })
  const textures = new Map()
  const makeTexture = vi.fn(({ x, y, width, height }) => new Texture({ source, frame: new Rectangle(x, y, width, height) }))
  const cleanup = vi.fn(() => {
    for (const texture of textures.values()) texture.destroy()
    source.destroy()
  })
  const load = vi.fn(async ({ id }) => ({
    frame(rect) {
      if (id !== atlas.id) return id === 'beginner-base-body-atlas' ? Texture.EMPTY : Texture.WHITE
      if (!textures.has(rect)) textures.set(rect, makeTexture(rect))
      return textures.get(rect)
    },
    destroy: id === atlas.id ? cleanup : () => {},
  }))
  const legacy = createAtlasScope(sprites, '/', load)
  const experiment = createAtlasScope(experimentSprites, '/', load)
  experiment.prepare(visualIds.beginnerIdle)
  experiment.prepare(visualIds.beginnerBaseBody)
  const local = createBeginnerView({ width: 24, height: 48 }, legacy, experiment, idlePose)
  const peer = createBeginnerView({ width: 24, height: 48 }, legacy, experiment, idlePose)
  const sprite = local.root.children[1]
  const remote = peer.root.children[1]
  const preview = { ...defaultCharacterPreview, mode: 'animated-base-body' }
  const frame = { state: 'idle', position: { x: 100, y: 250 }, facing: 'left', visualTick: 0 }
  try {
    await Promise.resolve()
    expect(makeTexture).toHaveBeenCalledTimes(4)
    const [first, inhale, peak, exhale] = [...textures.values()]
    for (const [tick, expected] of [
      [0, first],
      [11.999, first],
      [12, inhale],
      [24, peak],
      [36, exhale],
      [48, first],
    ]) {
      local.draw({ ...frame, visualTick: tick }, preview)
      expect(sprite.texture).toBe(expected)
      expect(sprite.position).toMatchObject({ x: 112, y: 298 })
      expect(sprite.anchor).toMatchObject({ x: 0.5, y: (320 - 8) / 368 })
      expect(sprite.scale).toMatchObject({ x: 0.3125, y: 0.3125 })
    }
    expect((clips.idle.frames.length * clips.idle.ticksPerFrame * 1000) / 30).toBe(800)
    expect(defaultCharacterPreview.idle.speed).toBe(0.5)
    expect(800 / defaultCharacterPreview.idle.speed).toBe(1600)
    peer.draw({ ...frame, visualTick: 59, facing: 'right' }, preview)
    local.draw({ ...frame, visualTick: 60 }, preview)
    expect(sprite.texture).toBe(inhale)
    expect(remote.texture).toBe(first)
    expect(remote.scale.x).toBe(-0.3125)
    peer.draw({ ...frame, visualTick: 71 }, preview)
    expect(remote.texture).toBe(inhale)

    const paused = { ...preview, idle: { ...preview.idle, playing: false } }
    local.draw({ ...frame, visualTick: 72 }, paused)
    expect(sprite.texture).toBe(inhale)
    const manual = { ...paused, idle: { ...paused.idle, frame: 2, showAttachments: true } }
    local.draw({ ...frame, visualTick: 73 }, manual, 'right')
    expect(sprite.texture).toBe(peak)
    const overlay = local.root.children.at(-1)
    expect(overlay.visible).toBe(true)
    expect(overlay.position).toMatchObject({ x: 112, y: 298 })
    expect(overlay.scale).toMatchObject({ x: -0.3125, y: 0.3125 })
    local.draw({ ...frame, visualTick: 76 }, { ...preview, idle: { ...preview.idle, speed: 2 } })
    expect(sprite.texture).toBe(exhale)
    for (const state of ['run', 'jump', 'fall', 'attack', 'hurt', 'death']) {
      local.draw({ ...frame, state, visualTick: 77 }, manual)
      expect(sprite.texture).toBe(Texture.EMPTY)
      expect(sprite.anchor.y).toBe(1)
      expect(overlay.visible).toBe(false)
    }
    local.draw({ ...frame, visualTick: 88 }, preview)
    expect(sprite.texture).toBe(first)
    const standard = { ...preview, idle: { ...preview.idle, speed: 1 } }
    local.draw({ ...frame, visualTick: 94 }, standard)
    expect(sprite.texture).toBe(inhale)
    expect(local.root.children[1]).toBe(sprite)
    expect(makeTexture).toHaveBeenCalledTimes(4)
    expect(load.mock.calls.filter(([entry]) => entry.id === atlas.id)).toHaveLength(1)
  } finally {
    for (const { root } of [local, peer]) root.destroy({ children: true, context: true })
    experiment.destroy()
    legacy.destroy()
  }
  expect(cleanup).toHaveBeenCalledOnce()
  expect([...textures.values()].every((texture) => texture.destroyed)).toBe(true)
  expect(source.destroyed).toBe(true)
})

test('Paper Doll composes a single phase with shared textures, per-frame order, and foot-root mirroring', async () => {
  const { catalog, files } = loadProjectAssets(false, true)
  const development = indexSprites(catalog)
  const { atlas: diagnostics } = development.get(diagnosticSpriteId)
  const { idlePose } = development.get(visualIds.beginnerIdle).sprite
  expect(files.has(diagnostics.output)).toBe(true)
  expect(loadProjectAssets().files.has(diagnostics.output)).toBe(false)
  expect(diagnostics.sprites.every(({ id }) => !sprites.has(id))).toBe(true)
  const cleanup = vi.fn()
  const textures = new Map()
  const load = vi.fn(async (atlas) => ({
    frame(rect) {
      if (!textures.has(rect)) textures.set(rect, new Texture({ source: new TextureSource({ width: rect.width, height: rect.height }) }))
      return textures.get(rect)
    },
    destroy: () => cleanup(atlas.id),
  }))
  const assets = createAtlasScope(development, '/', load)
  const local = createBeginnerView({ width: 24, height: 48 }, assets, assets, idlePose)
  const peer = createBeginnerView({ width: 24, height: 48 }, assets, assets, idlePose)
  for (const id of [visualIds.beginnerIdle, visualIds.beginnerBaseBody, diagnosticSpriteId]) assets.prepare(id, true)
  await Promise.resolve()
  const textureFor = (id, index = 0) => textures.get(development.get(id).sprite.clips.idle.frames[index])
  const frame = { state: 'idle', position: { x: 100, y: 250 }, facing: 'left', visualTick: 0 }
  const preview = { ...defaultCharacterPreview, mode: 'paper-doll', showDiagnosticLayers: true }
  const draw = (view, tick, options = preview, facing = 'left') => view.draw({ ...frame, visualTick: tick }, options, facing)
  draw(local, 0)
  draw(peer, 12, preview, 'right')
  const localDoll = local.root.children[2]
  const peerDoll = peer.root.children[2]
  const [stack] = localDoll.children
  const [back, body, face, front] = stack.children
  const expectedLayers = [diagnosticSpriteId, visualIds.beginnerIdle, 'beginner-diagnostic-face', 'beginner-diagnostic-front']
  expect(stack.children.map(({ texture }) => texture)).toEqual(expectedLayers.map((id) => textureFor(id)))
  expect(peerDoll.children[0].children.map(({ texture }) => texture)).toEqual(stack.children.map(({ texture }) => texture))
  expect(localDoll.position).toMatchObject({ x: 112, y: 298 })
  expect(peerDoll.position).toMatchObject({ x: 112, y: 298 })
  expect(stack.scale).toMatchObject({ x: 0.3125, y: 0.3125 })
  expect(peerDoll.children[0].scale).toMatchObject({ x: -0.3125, y: 0.3125 })
  const leftMark = front.toGlobal({ x: 0, y: 0 })
  const rightMark = peerDoll.children[0].children[3].toGlobal({ x: 0, y: 0 })
  expect(leftMark.x + rightMark.x).toBeCloseTo(224, 8)
  expect(leftMark.y).toBeCloseTo(rightMark.y, 8)
  expect(body.position).toMatchObject({ x: -184, y: -312 })
  expect(face.pivot).toMatchObject({ x: 15, y: 9 })
  const sort = vi.spyOn(stack, 'setChildIndex')
  draw(local, 12)
  expect(sort).not.toHaveBeenCalled()
  expect(body.texture).toBe(textureFor(visualIds.beginnerIdle, 1))
  expect(peerDoll.children[0].children[1].texture).toBe(textureFor(visualIds.beginnerIdle))
  const manual = { ...preview, idle: { ...preview.idle, frame: 2, playing: false, showAttachments: true } }
  draw(local, 13, manual, 'right')
  const { head, face: faceAnchor } = idlePose.frames[2].attachments
  expect(back.position).toMatchObject({ x: head.x - 192, y: head.y - 320 })
  expect(front.position).toMatchObject({ x: back.x, y: back.y })
  expect(face.position).toMatchObject({ x: faceAnchor.x - 192, y: faceAnchor.y - 320 })
  expect(stack.children).toEqual([back, body, front, face])
  expect(local.layerOrder).toBe('F2 · backHair → baseBody → frontHair → face')
  expect(body.texture).toBe(textureFor(visualIds.beginnerIdle, 2))
  draw(local, 80, { ...manual, idle: { ...manual.idle, frame: null } })
  expect(body.texture).toBe(textureFor(visualIds.beginnerIdle, 2))
  draw(local, 83, { ...preview, idle: { ...preview.idle, speed: 2 } })
  expect(body.texture).toBe(textureFor(visualIds.beginnerIdle, 3))
  expect(front.visible).toBe(false)
  expect([back, face].every(({ visible }) => visible)).toBe(true)
  draw(local, 95)
  expect(stack.children).toEqual([back, body, face, front])
  expect(front.visible).toBe(true)
  draw(local, 95, { ...preview, showDiagnosticLayers: false })
  expect(local.layerOrder).toBe('F0 · baseBody')
  expect(stack.children.filter(({ visible }) => visible)).toEqual([body])
  local.root.destroy({ children: true, context: true })
  draw(peer, 96)
  expect(peerDoll.children[0].children[1].texture.destroyed).toBe(false)
  expect(cleanup).not.toHaveBeenCalled()
  expect(load.mock.calls.filter(([atlas]) => atlas.id === diagnostics.id)).toHaveLength(1)
  peer.root.destroy({ children: true, context: true })
  assets.destroy()
  expect(cleanup.mock.calls.filter(([id]) => id === diagnostics.id)).toHaveLength(1)
  for (const texture of textures.values()) texture.destroy(true)
})

test('pose-specific parts reuse the shared frame index and a missing split part hides its partner', async () => {
  const { catalog } = loadProjectAssets(false, true)
  const development = indexSprites(catalog)
  const { idlePose } = development.get(visualIds.beginnerIdle).sprite
  const scope = createAtlasScope(development, '/', async () => ({ frame: () => Texture.WHITE, destroy() {} }))
  scope.prepare(diagnosticSpriteId, true)
  await Promise.resolve()
  const resolve = vi.spyOn(scope, 'textureAt')
  const view = createPaperDollView(scope, idlePose.pivotPx)
  const parts = { face: { kind: 'pose', spriteId: diagnosticSpriteId, offsetPx: { x: 10, y: 20 } } }
  const weapon = { kind: 'attached', spriteId: diagnosticSpriteId, attachment: 'mainHand', originPx: { x: 1, y: 2 } }
  const order = ['baseBody', 'face', 'weaponBack', 'weaponFront', 'bodyForeground']
  view.draw(idlePose.frames[0], 'idle', 0, Texture.WHITE, order, { ...parts, weaponBack: weapon, bodyForeground: parts.face }, 0, 0, 1, 1)
  const [, face] = view.root.children[0].children
  expect(face.position).toMatchObject({ x: -182, y: -300 })
  expect(view.order).toBe('baseBody → face')
  view.draw(idlePose.frames[1], 'idle', 1, Texture.WHITE, order, { ...parts, weaponBack: weapon, weaponFront: null }, 0, 0, 1, 1)
  expect(resolve).toHaveBeenCalledWith(diagnosticSpriteId, 'idle', 1)
  expect(view.order).toBe('baseBody → weaponBack')
  expect(view.root.children[0].children[1].angle).toBeCloseTo(idlePose.frames[1].attachments.mainHand.rotationDeg)
  view.root.destroy({ children: true })
  scope.destroy()
})

test('Paper Doll falls back to static and legacy bodies when the Idle sheet is unavailable', async () => {
  const development = indexSprites(loadProjectAssets(false, true).catalog)
  const { idlePose } = development.get(visualIds.beginnerIdle).sprite
  const legacy = createAtlasScope(sprites, '/', async () => ({ frame: () => Texture.WHITE, destroy() {} }))
  const preview = { ...defaultCharacterPreview, mode: 'paper-doll', idle: { ...defaultCharacterPreview.idle, showAttachments: true } }
  const frame = { state: 'idle', position: { x: 100, y: 250 }, facing: 'left', visualTick: 0 }
  for (const hasStaticBody of [true, false]) {
    const assets = createAtlasScope(development, '/', async ({ id }) => {
      if (id === 'beginner-base-body-idle-atlas' || (id === 'beginner-base-body-atlas' && !hasStaticBody)) throw new Error('offline')
      return { frame: () => Texture.EMPTY, destroy() {} }
    })
    const view = createBeginnerView({ width: 24, height: 48 }, legacy, assets, idlePose)
    for (const id of [visualIds.beginnerIdle, visualIds.beginnerBaseBody, diagnosticSpriteId]) assets.prepare(id)
    await Promise.resolve()
    view.draw(frame, preview)
    expect(view.layerOrder).toBeUndefined()
    expect(view.root.children).toHaveLength(2)
    expect(view.root.children[1].visible).toBe(true)
    expect(view.root.children[1].texture).toBe(hasStaticBody ? Texture.EMPTY : Texture.WHITE)
    view.root.destroy({ children: true, context: true })
    assets.destroy()
  }
  legacy.destroy()
})

test('Face 01 follows every Idle face anchor and mirrors the calibrated local transform around the feet', async () => {
  const development = indexSprites(loadProjectAssets(false, true).catalog)
  const { idlePose } = development.get(visualIds.beginnerIdle).sprite
  const { atlas, sprite: definition } = development.get(face01SpriteId)
  const { originPx, offsetPx, defaultCalibration: faceCalibration } = definition.attachedFace
  const faceLayers = { face: { kind: 'attached', spriteId: face01SpriteId, attachment: 'face', originPx } }
  const source = new TextureSource({ width: atlas.width, height: atlas.height })
  const faceTexture = new Texture({ source })
  const staticTexture = new Texture({ source: new TextureSource({ width: 180, height: 256 }) })
  const freeFace = vi.fn(() => faceTexture.destroy(true))
  const load = vi.fn(async ({ id }) => {
    if (id === atlas.id) return { frame: () => faceTexture, destroy: freeFace }
    if (id === 'beginner-base-body-atlas') return { frame: () => staticTexture, destroy: () => staticTexture.destroy(true) }
    return { frame: () => Texture.WHITE, destroy() {} }
  })
  const assets = createAtlasScope(development, '/', load)
  const local = createBeginnerView({ width: 24, height: 48 }, assets, assets, idlePose, faceLayers)
  const peer = createBeginnerView({ width: 24, height: 48 }, assets, assets, idlePose, faceLayers)
  assets.prepare(visualIds.beginnerIdle)
  assets.prepare(face01SpriteId, true)
  await Promise.resolve()
  const frame = { state: 'idle', position: { x: 100, y: 250 }, facing: 'left', visualTick: 0 }
  const preview = { ...defaultCharacterPreview, mode: 'paper-doll' }
  local.draw(frame, preview)
  peer.draw(frame, preview, 'right')
  const [body, face] = local.root.children[2].children[0].children
  const remoteFace = peer.root.children[2].children[0].children[1]
  const feet = { x: 112, y: 298 }
  const scale = 80 / 256
  expect(body.position).toMatchObject({ x: -184, y: -312 })
  expect(face.texture).toBe(faceTexture)
  expect(remoteFace.texture).toBe(faceTexture)
  const neutral = face.toGlobal({ x: 0, y: 0 })
  expect(neutral.x).toBeCloseTo(feet.x + (offsetPx.x - 192) * scale, 8)
  expect(neutral.y).toBeCloseTo(feet.y + (offsetPx.y - 320) * scale, 8)
  for (const [index, { attachments }] of idlePose.frames.entries()) {
    const paused = { ...preview, faceCalibration, idle: { ...preview.idle, playing: false, frame: index } }
    local.draw(frame, paused, 'left')
    expect(local.layerOrder).toBe(`F${index} · baseBody → face`)
    expect(face.position.x).toBeCloseTo(attachments.face.x - 192 + faceCalibration.xPx, 8)
    expect(face.position.y).toBeCloseTo(attachments.face.y - 320 + faceCalibration.yPx, 8)
    expect(face.scale).toMatchObject({ x: faceCalibration.scale, y: faceCalibration.scale })
    const left = face.toGlobal({ x: 0, y: 0 })
    local.draw(frame, paused, 'right')
    const right = face.toGlobal({ x: 0, y: 0 })
    expect(left.x + right.x).toBeCloseTo(2 * feet.x, 8)
    expect(left.y).toBeCloseTo(right.y, 8)
    expect(body.position).toMatchObject({ x: -184, y: -312 })
    expect(body.scale).toMatchObject({ x: 1, y: 1 })
  }
  local.draw(frame, { ...preview, showFace: false })
  expect(face.visible).toBe(false)
  local.draw(frame, preview)
  expect(local.root.children[2].children[0].children[1]).toBe(face)
  expect(face.visible).toBe(true)
  expect(face.texture).toBe(faceTexture)
  expect(face.scale.x).toBe(1)
  const doll = local.root.children[2]
  const stack = doll.children[0]
  const calibrated = { ...preview, faceCalibration }
  const { face: neutralAnchor } = idlePose.frames[0].attachments
  local.draw({ ...frame, state: 'run', visualTick: 149 }, calibrated)
  expect(local.layerOrder).toBe('Neutral · baseBody → face')
  expect(body.texture).toBe(Texture.WHITE)
  expect(body.position).toMatchObject({ x: -184, y: -312 })
  assets.prepare(visualIds.beginnerBaseBody)
  await Promise.resolve()
  for (const state of beginnerStates.filter((state) => state !== 'idle')) {
    local.draw({ ...frame, state, visualTick: 150 }, calibrated)
    const left = face.toGlobal({ x: 0, y: 0 })
    local.draw({ ...frame, state, visualTick: 183 }, calibrated, 'right')
    const right = face.toGlobal({ x: 0, y: 0 })
    expect(local.layerOrder).toBe('Neutral · baseBody → face')
    expect(local.root.children[2]).toBe(doll)
    expect(stack.children).toEqual([body, face])
    expect(body.texture).toBe(staticTexture)
    expect(body.position).toMatchObject({ x: -90, y: -256 })
    expect(face.texture).toBe(faceTexture)
    expect(face.position.x).toBeCloseTo(neutralAnchor.x - 192 + faceCalibration.xPx, 8)
    expect(face.position.y).toBeCloseTo(neutralAnchor.y - 320 + faceCalibration.yPx, 8)
    expect(left.x + right.x).toBeCloseTo(2 * feet.x, 8)
    expect(left.y).toBeCloseTo(right.y, 8)
  }
  local.draw({ ...frame, state: 'run', visualTick: 184 }, { ...calibrated, showFace: false })
  expect(local.layerOrder).toBe('Neutral · baseBody')
  local.draw({ ...frame, visualTick: 185 }, calibrated)
  expect(local.layerOrder).toBe('F0 · baseBody → face')
  expect(body.texture).toBe(Texture.WHITE)
  expect(stack.children).toEqual([body, face])
  local.root.destroy({ children: true, context: true })
  expect(remoteFace.texture.destroyed).toBe(false)
  expect(load.mock.calls.filter(([entry]) => entry.id === atlas.id)).toHaveLength(1)
  peer.root.destroy({ children: true, context: true })
  assets.destroy()
  expect(freeFace).toHaveBeenCalledOnce()
  expect(faceTexture.destroyed).toBe(true)
  expect(source.destroyed).toBe(true)
})
