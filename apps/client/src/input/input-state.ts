import { normalizeMovementInput, type MovementInput } from '@viesma/simulation'

const auxiliaryActions = ['interact', 'pickup', 'hpPotion', 'mpPotion', 'inventory', 'party', 'ap'] as const
export type AuxiliaryAction = (typeof auxiliaryActions)[number]
export type InputControl = 'left' | 'right' | 'up' | 'jump' | 'attack' | AuxiliaryAction
type EdgeControl = Exclude<InputControl, 'left' | 'right'>
type InputSource = string | number

export interface InputSample extends MovementInput {
  readonly portalPressed: boolean
  readonly attackPressed: boolean
  readonly actions: readonly AuxiliaryAction[]
}

export function createInputState() {
  // 鍵盤以 code 區分來源，觸控以 pointerId 區分來源。
  const held = new Map<InputSource, InputControl>()
  const edges = new Map<EdgeControl, InputSource>()
  const isHeld = (control: InputControl) => Array.from(held.values()).includes(control)

  return {
    press(source: InputSource, control: InputControl) {
      if (held.has(source)) return
      if (control !== 'left' && control !== 'right' && !isHeld(control) && !edges.has(control)) edges.set(control, source)
      held.set(source, control)
    },
    release(source: InputSource) {
      held.delete(source)
    },
    cancel(source: InputSource) {
      const control = held.get(source)
      if (control !== undefined && control !== 'left' && control !== 'right' && edges.get(control) === source) edges.delete(control)
      held.delete(source)
    },
    clear() {
      held.clear()
      edges.clear()
    },
    sample(): InputSample {
      // Jump 已在合併後的按下轉換鎖存，讓 tick 之間的短按也能被消費一次。
      const movement = normalizeMovementInput({ left: isHeld('left'), right: isHeld('right'), jump: edges.has('jump') }, false)
      const sample = {
        ...movement,
        portalPressed: edges.has('up'),
        attackPressed: edges.has('attack'),
        actions: auxiliaryActions.filter((action) => edges.has(action)),
      }
      edges.clear()
      return sample
    },
  }
}
