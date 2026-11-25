import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

export async function installMovementRecorder(page) {
  await page.addInitScript(() => {
    const { document, performance } = globalThis
    const events = []
    const frames = []
    const transfer = []
    let startedAt
    let inTransfer = false
    let droppedEvents = 0
    let droppedFrames = 0

    const observer = {
      start(characterId, start) {
        startedAt = start
        observer.targetCharacterId = characterId
        lifecycle('start')
      },
      record(event) {
        if (!observer.targetCharacterId) return
        if (event.kind === 'checkpoint' && event.result !== 'ignored') observer.checkpoint = event
        if (inTransfer) {
          if (
            transfer.length < 384 &&
            ['checkpoint', 'portal-edge', 'transfer-offer', 'lifecycle', 'pointerdown', 'pointerup', 'pointercancel'].includes(event.kind)
          )
            transfer.push({ tMs: Math.round(performance.timeOrigin + performance.now() - startedAt), ...event })
          return
        }
        if (event.kind === 'render') {
          // 用相鄰原生 rAF 時戳計算間隔，記錄實際 render 的目標角色。
          if (frames.length < 640) {
            const rafMs = Math.round(performance.timeOrigin + event.rafMs - startedAt)
            const gapMs = frames.length ? rafMs - frames.at(-1).rafMs : null
            frames.push({ ...event, rafMs, gapMs })
          } else droppedFrames++
          return
        }
        if (events.length < 480) events.push({ tMs: Math.round(performance.timeOrigin + performance.now() - startedAt), ...event })
        else droppedEvents++
      },
      beginTransfer() {
        inTransfer = true
      },
      stop(save) {
        lifecycle('stop')
        observer.targetCharacterId = undefined
        if (save) return { events, frames, droppedEvents, droppedFrames, transfer }
      },
    }

    function lifecycle(event) {
      observer.record({ kind: 'lifecycle', event, visibility: document.visibilityState, focused: document.hasFocus() })
    }

    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
      globalThis.addEventListener(
        type,
        (event) => {
          if (observer.targetCharacterId && event.pointerType === 'touch')
            observer.record({
              kind: event.type,
              pointerId: event.pointerId,
              control: event.target.closest?.('[data-input-control]')?.dataset.inputControl ?? null,
            })
        },
        { capture: true }
      )
    }
    for (const type of ['focus', 'blur']) globalThis.addEventListener(type, () => lifecycle(type))
    document.addEventListener('visibilitychange', () => lifecycle('visibilitychange'))
    globalThis.__viesmaMovementSmoke = observer
  })
}

export async function startMobileJumpTrace(fixture, seat, characterId, traveler, spectator, testInfo, chromium, marks, startedAt) {
  const pages = [traveler, spectator]
  await Promise.all(
    pages.map((page) =>
      page.evaluate(({ characterId, startedAt }) => globalThis.__viesmaMovementSmoke.start(characterId, startedAt), {
        characterId,
        startedAt,
      })
    )
  )
  const serverTrace = fixture.startMovementTrace(seat, startedAt)

  return {
    mark(kind, details = {}) {
      if (marks.length < 64) marks.push({ kind, tMs: Math.round(performance.timeOrigin + performance.now() - startedAt), ...details })
    },
    async beginTransfer() {
      serverTrace.beginTransfer()
      await Promise.all(pages.map((page) => page.evaluate(() => globalThis.__viesmaMovementSmoke.beginTransfer())))
    },
    async finish(save) {
      const server = serverTrace.stop()
      const [mobile, observer] = await Promise.allSettled(
        pages.map((page) => page.evaluate((save) => globalThis.__viesmaMovementSmoke.stop(save), save))
      )
      if (!save) return
      const trace = {
        chromium,
        characterId,
        marks,
        server,
        mobile: mobile.status === 'fulfilled' ? mobile.value : null,
        spectator: observer.status === 'fulfilled' ? observer.value : null,
      }
      const path = testInfo.outputPath('mobile-jump-trace.json')
      await writeFile(path, JSON.stringify(trace))
      await testInfo.attach('mobile-jump-trace', { path, contentType: 'application/json' })
    },
  }
}
