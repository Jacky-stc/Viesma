import { describe, expect, it } from 'vitest'
import { followCamera } from '../src/rendering/camera'

const bounds = { origin: { x: -300, y: -200 }, width: 2000, height: 1000 }
const viewport = { width: 1280, height: 720 }

describe('playground camera', () => {
  it('centers a moving visual target with sub-unit precision', () => {
    expect(followCamera({ x: 500.5, y: 225.25 }, bounds, viewport)).toEqual({
      origin: { x: -139.5, y: -134.75 },
      scale: 1,
    })
  })

  it('clamps independently at both ends of each axis', () => {
    expect(followCamera({ x: -500, y: -500 }, bounds, viewport).origin).toEqual({ x: -300, y: -200 })
    expect(followCamera({ x: 3500, y: 3000 }, bounds, viewport).origin).toEqual({ x: 420, y: 80 })
  })

  it('centers axes smaller than the viewport and keeps the available axis free to follow', () => {
    const small = { ...bounds, height: 400 }
    expect(followCamera({ x: 600, y: -190 }, small, viewport).origin).toEqual({ x: -40, y: -360 })
    expect(followCamera({ x: 750, y: 800 }, small, viewport).origin).toEqual({ x: 110, y: -360 })
    expect(followCamera({ x: 750, y: 800 }, { ...small, width: 800 }, viewport).origin).toEqual({ x: -540, y: -360 })
  })

  it('recomputes visible world dimensions on resize without changing bounds or target', () => {
    const frozenBounds = Object.freeze({ ...bounds, origin: Object.freeze({ ...bounds.origin }) })
    const target = Object.freeze({ x: 900, y: 550 })
    expect(followCamera(target, frozenBounds, { width: 960, height: 360 })).toEqual({
      origin: { x: -220, y: 80 },
      scale: 0.5,
    })
    expect(followCamera(target, frozenBounds, { width: 640, height: 360 })).toEqual({
      origin: { x: 260, y: 80 },
      scale: 0.5,
    })
  })
})
