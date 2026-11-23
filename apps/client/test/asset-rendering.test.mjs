import { Texture } from 'pixi.js'
import { expect, test, vi } from 'vitest'
import { createAtlasScope } from '../src/rendering/assets/atlas-scope.ts'
import { beginnerStates, indexSprites, resolveFrame, visualIds } from '../src/rendering/assets/catalog.ts'
import { createBeginnerView } from '../src/rendering/assets/sprite-views.ts'
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
