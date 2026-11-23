import { describe, expect, it, vi } from 'vitest'
import { attachBrowserInput, touchControls } from '../src/input/browser-input'

const { AbortController, Event, EventTarget } = globalThis

function emit(target, type, fields = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), fields)
  target.dispatchEvent(event)
  return event
}

function attachInput() {
  const controller = new AbortController()
  const window = new EventTarget()
  const portrait = Object.assign(new EventTarget(), { matches: false })
  window.matchMedia = () => portrait
  const document = Object.assign(new EventTarget(), { defaultView: window, hidden: false })
  const buttons = new Map(
    touchControls.map(({ control }) => {
      const captured = new Set()
      const button = Object.assign(new EventTarget(), {
        setPointerCapture: (id) => captured.add(id),
        hasPointerCapture: (id) => captured.has(id),
        releasePointerCapture: (id) => captured.delete(id),
      })
      return [`button[data-input-control="${control}"]`, button]
    })
  )
  const surface = Object.assign(new EventTarget(), {
    ownerDocument: document,
    querySelector: (selector) => buttons.get(selector),
    focus: vi.fn(),
  })
  const input = attachBrowserInput(surface, controller.signal)
  return {
    surface,
    window,
    document,
    portrait,
    controller,
    sample: input.sample,
    keyDown: (code, options) => emit(surface, 'keydown', { code, ...options }),
    keyUp: (code) => emit(surface, 'keyup', { code }),
    pointerDown: (control, pointerId) => {
      const button = buttons.get(`button[data-input-control="${control}"]`)
      emit(button, 'pointerdown', { pointerId, button: 0 })
      return button
    },
    pointerEnd: (type, pointerId, button) => {
      button.releasePointerCapture(pointerId)
      emit(window, type, { pointerId })
    },
  }
}

describe('playground browser input', () => {
  it('handles key press, aliases, opposite directions and key release', () => {
    const { keyDown, keyUp, sample } = attachInput()
    expect(keyDown('ArrowLeft').defaultPrevented).toBe(true)
    keyDown('KeyA')
    keyUp('ArrowLeft')
    expect(sample().moveX).toBe(-1)
    keyDown('KeyD')
    expect(sample().moveX).toBe(0)
    keyUp('KeyA')
    expect(sample().moveX).toBe(1)
    keyUp('KeyD')
    expect(sample().moveX).toBe(0)
    expect(keyDown('Tab').defaultPrevented).toBe(false)
    expect(keyDown('KeyA', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(sample().moveX).toBe(0)
  })

  it('emits a jump edge for a short tap and ignores held or repeated keydown', () => {
    const { keyDown, keyUp, sample } = attachInput()
    keyDown('Space')
    keyUp('Space')
    expect(sample().jumpPressed).toBe(true)
    expect(sample().jumpPressed).toBe(false)
    keyDown('Space')
    expect(sample().jumpPressed).toBe(true)
    expect(keyDown('Space', { repeat: true }).defaultPrevented).toBe(true)
    expect(sample().jumpPressed).toBe(false)
    keyDown('Space')
    expect(sample().jumpPressed).toBe(false)
    keyUp('Space')
    keyDown('Space')
    expect(sample().jumpPressed).toBe(true)
  })

  it.each(['window blur', 'surface blur', 'pagehide', 'visibility', 'rotation'])(
    'clears directions, captures and pending edges on %s and waits for a new press',
    (interruption) => {
      const { surface, window, document, portrait, keyDown, sample, pointerDown } = attachInput()
      const right = pointerDown('right', 1)
      keyDown('Space')
      keyDown('KeyJ')
      if (interruption === 'window blur') emit(window, 'blur')
      if (interruption === 'surface blur') emit(surface, 'blur')
      if (interruption === 'pagehide') emit(window, 'pagehide')
      if (interruption === 'visibility') {
        document.hidden = true
        emit(document, 'visibilitychange')
      }
      if (interruption === 'rotation') {
        portrait.matches = true
        emit(portrait, 'change')
      }
      expect(right.hasPointerCapture(1)).toBe(false)
      expect(sample()).toEqual({ moveX: 0, jumpPressed: false, portalPressed: false, attackPressed: false, actions: [] })
      if (interruption === 'visibility' || interruption === 'rotation') {
        expect(keyDown('ArrowRight').defaultPrevented).toBe(false)
        pointerDown('jump', 2)
        expect(sample()).toMatchObject({ moveX: 0, jumpPressed: false })
        document.hidden = false
        portrait.matches = false
        emit(document, 'visibilitychange')
        emit(portrait, 'change')
      }
      keyDown('Space', { repeat: true })
      expect(sample().jumpPressed).toBe(false)
      keyDown('Space')
      expect(sample().jumpPressed).toBe(true)
    }
  )

  it('tracks simultaneous pointers through release, cancellation and lost capture', () => {
    const { window, pointerDown, pointerEnd, sample } = attachInput()
    const move = pointerDown('right', 1)
    const jump = pointerDown('jump', 2)
    const attack = pointerDown('attack', 3)
    expect(sample()).toMatchObject({ moveX: 1, jumpPressed: true, attackPressed: true })
    pointerEnd('pointerup', 2, jump)
    pointerEnd('pointercancel', 3, attack)
    expect(sample()).toMatchObject({ moveX: 1, jumpPressed: false, attackPressed: false })
    pointerEnd('lostpointercapture', 1, move)
    expect(sample().moveX).toBe(0)
    const cancelledTap = pointerDown('jump', 4)
    pointerEnd('pointercancel', 4, cancelledTap)
    expect(sample().jumpPressed).toBe(false)
    const completedTap = pointerDown('jump', 4)
    pointerEnd('pointerup', 4, completedTap)
    emit(window, 'lostpointercapture', { pointerId: 4 })
    expect(sample().jumpPressed).toBe(true)
  })

  it('releases a captured direction when movement arrives after capture was silently withdrawn', () => {
    const { window, pointerDown, sample } = attachInput()
    const right = pointerDown('right', 1)
    emit(window, 'pointermove', { pointerId: 1 })
    expect(sample().moveX).toBe(1)
    right.releasePointerCapture(1)
    emit(window, 'pointermove', { pointerId: 1 })
    expect(sample().moveX).toBe(0)
  })

  it('merges keyboard and touch sources before generating edges or resolving directions', () => {
    const { keyDown, keyUp, pointerDown, pointerEnd, sample } = attachInput()
    keyDown('ArrowLeft')
    const left = pointerDown('left', 1)
    const right = pointerDown('right', 2)
    expect(sample().moveX).toBe(0)
    pointerEnd('pointerup', 2, right)
    pointerEnd('pointerup', 1, left)
    expect(sample().moveX).toBe(-1)
    keyUp('ArrowLeft')
    keyDown('Space')
    const jump = pointerDown('jump', 3)
    expect(sample().jumpPressed).toBe(true)
    keyUp('Space')
    keyDown('Space')
    expect(sample().jumpPressed).toBe(false)
    keyUp('Space')
    pointerEnd('pointerup', 3, jump)
    keyDown('Space')
    expect(sample().jumpPressed).toBe(true)
  })

  it('normalizes keyboard and touch actions with the same one-shot behavior', () => {
    const { keyDown, pointerDown, sample } = attachInput()
    keyDown('KeyE')
    pointerDown('interact', 1)
    pointerDown('pickup', 2)
    keyDown('Digit1')
    pointerDown('mpPotion', 3)
    keyDown('KeyI')
    keyDown('KeyP')
    keyDown('KeyK')
    expect(sample().actions).toEqual(['interact', 'pickup', 'hpPotion', 'mpPotion', 'inventory', 'party', 'ap'])
    expect(sample().actions).toEqual([])
  })

  it('removes listeners, releases pointer capture and clears pending input on unmount', () => {
    const { controller, keyDown, pointerDown, sample } = attachInput()
    const button = pointerDown('right', 1)
    keyDown('Space')
    expect(button.hasPointerCapture(1)).toBe(true)
    controller.abort()
    expect(button.hasPointerCapture(1)).toBe(false)
    expect(keyDown('KeyJ').defaultPrevented).toBe(false)
    expect(pointerDown('left', 2).hasPointerCapture(2)).toBe(false)
    expect(sample()).toEqual({ moveX: 0, jumpPressed: false, portalPressed: false, attackPressed: false, actions: [] })
  })
})
