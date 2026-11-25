export async function installFrameClock(page) {
  await page.addInitScript(() => {
    const queue = new Map()
    let id = 0
    let tick = 0
    const now = globalThis.performance.now() + 0.01
    const requestBrowserFrame = globalThis.requestAnimationFrame.bind(globalThis)
    globalThis.waitForBrowserFrame = () => new Promise((resolve) => requestBrowserFrame(() => resolve()))
    globalThis.requestAnimationFrame = (callback) => {
      queue.set(++id, callback)
      return id
    }
    globalThis.cancelAnimationFrame = (pending) => queue.delete(pending)
    globalThis.drawWorld = (ticks) => {
      // 每次最多畫四個 tick 的間隔，保留實際 fixed-tick driver 的 catch-up 上限。
      do {
        const elapsed = Math.min(ticks, 4)
        tick += elapsed
        ticks -= elapsed
        for (const frame of [...queue.keys()]) {
          const callback = queue.get(frame)
          queue.delete(frame)
          callback?.(now + (tick * 1000) / 30 + (tick > 0 ? 0.01 : 0))
        }
      } while (ticks > 0)
    }
  })
  return (ticks) => page.evaluate((ticks) => globalThis.drawWorld(ticks), ticks)
}

export function waitForBrowserFrame(page) {
  return page.evaluate(() => globalThis.waitForBrowserFrame())
}
