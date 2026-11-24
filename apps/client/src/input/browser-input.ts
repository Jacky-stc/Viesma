import { createInputState, type InputControl } from './input-state'

const keyBindings: ReadonlyMap<string, InputControl> = new Map([
  ['ArrowLeft', 'left'],
  ['KeyA', 'left'],
  ['ArrowRight', 'right'],
  ['KeyD', 'right'],
  ['ArrowUp', 'up'],
  ['KeyW', 'up'],
  ['Space', 'jump'],
  ['KeyJ', 'attack'],
  ['KeyE', 'interact'],
  ['KeyF', 'pickup'],
  ['Digit1', 'hpPotion'],
  ['Digit2', 'mpPotion'],
  ['KeyI', 'inventory'],
  ['KeyP', 'party'],
  ['KeyK', 'ap'],
])

export const touchControls = [
  { control: 'left', label: '向左', text: '←' },
  { control: 'right', label: '向右', text: '→' },
  { control: 'up', label: '進入傳送門', text: '↑' },
  { control: 'jump', label: '跳躍', text: '跳' },
  { control: 'attack', label: '攻擊', text: '攻' },
  { control: 'interact', label: '互動', text: '互動' },
  { control: 'pickup', label: '拾取', text: '拾取' },
  { control: 'hpPotion', label: 'HP 藥水', text: 'HP' },
  { control: 'mpPotion', label: 'MP 藥水', text: 'MP' },
] as const satisfies ReadonlyArray<{ control: InputControl; label: string; text: string }>

export function attachBrowserInput(surface: HTMLElement, signal: AbortSignal) {
  const input = createInputState()
  const document = surface.ownerDocument
  const window = document.defaultView
  if (!window || signal.aborted) return input

  const portrait = window.matchMedia('(any-pointer: coarse) and (orientation: portrait)')
  const captures = new Map<number, HTMLButtonElement>()
  const options = { signal }
  const enabled = () => !portrait.matches && !document.hidden

  function releasePointers(preserveUp: boolean) {
    for (const [id, button] of captures) {
      if (preserveUp && button.dataset.inputControl === 'up') continue
      captures.delete(id)
      if (button.hasPointerCapture(id)) button.releasePointerCapture(id)
    }
  }

  function clear() {
    input.clear()
    releasePointers(false)
  }

  surface.addEventListener(
    'keydown',
    (event) => {
      if (event.target !== surface || !enabled() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
      const control = keyBindings.get(event.code)
      if (control === undefined) return
      event.preventDefault()
      if (!event.repeat) input.press(event.code, control)
    },
    options
  )
  surface.addEventListener('keyup', (event) => input.release(event.code), options)
  surface.addEventListener('blur', clear, options)
  window.addEventListener('blur', clear, options)
  window.addEventListener('pagehide', clear, options)
  document.addEventListener('visibilitychange', clear, options)
  portrait.addEventListener('change', clear, options)
  signal.addEventListener('abort', clear, { once: true })

  for (const { control } of touchControls) {
    const button = surface.querySelector<HTMLButtonElement>(`button[data-input-control="${control}"]`)
    if (!button) continue
    button.addEventListener(
      'pointerdown',
      (event) => {
        if (!enabled() || event.button !== 0 || captures.has(event.pointerId)) return
        event.preventDefault()
        surface.focus({ preventScroll: true })
        button.setPointerCapture(event.pointerId)
        captures.set(event.pointerId, button)
        input.press(event.pointerId, control)
      },
      options
    )
  }

  function endPointer(id: number, released: boolean) {
    if (!captures.delete(id)) return
    if (released) input.release(id)
    else input.cancel(id)
  }

  const pointerOptions = { signal, capture: true }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    window.addEventListener(type, (event) => endPointer(event.pointerId, type === 'pointerup'), pointerOptions)
  }
  window.addEventListener(
    'pointermove',
    (event) => {
      const button = captures.get(event.pointerId)
      // 擷取若在生效前就被撤回，瀏覽器可能只送出移動而沒有 lostpointercapture。
      if (button && !button.hasPointerCapture(event.pointerId)) endPointer(event.pointerId, false)
    },
    pointerOptions
  )

  return {
    ...input,
    clear,
    clearForRoomChange() {
      input.clearForRoomChange()
      releasePointers(true)
    },
  }
}
