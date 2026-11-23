export interface RandomSource {
  /** 回傳 [0, 1) 內的值。 */
  nextUnit(): number
}

/** 供可重播的 simulation 使用，呼叫端持有 seed 與 RNG 實例。 */
export function createSeededRng(seed: number): RandomSource {
  const uint32Range = 0x1_0000_0000
  if (!Number.isInteger(seed) || seed < 0 || seed >= uint32Range) {
    throw new RangeError('RNG seed must be an unsigned 32-bit integer')
  }

  let state = seed
  return {
    nextUnit() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / uint32Range
    },
  }
}
