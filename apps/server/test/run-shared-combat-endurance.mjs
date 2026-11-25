import assert from 'node:assert/strict'
import console from 'node:console'
import { cpus, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { clearInterval, setInterval } from 'node:timers'
import { setTimeout } from 'node:timers/promises'
import { createMemoryEncounterRewardPort } from '../dist/runtime/encounter-reward-worker.js'
import { createWorldCoordinator } from '../dist/runtime/world-coordinator.js'
import { createSharedCombatLoop } from './shared-combat-loop.mjs'

const durationMilliseconds = 600_000
const lastCycleAdmissionMilliseconds = 570_000
const controller = new globalThis.AbortController()
const interrupted = () => controller.abort()
process.once('SIGINT', interrupted)
process.once('SIGTERM', interrupted)

let timer
let loop
let backlogEpisodes = 0
let backlogRecoveries = 0
let maxBacklogTicks = 0
let result
const failed = Promise.withResolvers()
const start = performance.now()
console.info('[M4.5] Starting the 600-second wall-clock shared combat loop')
try {
  loop = createSharedCombatLoop(createWorldCoordinator, createMemoryEncounterRewardPort(), {
    clock: { nowMilliseconds: () => performance.now() },
    onBacklog: () => backlogEpisodes++,
    onBacklogRecovered: () => backlogRecoveries++,
    schedule(wake, milliseconds) {
      timer = setInterval(() => {
        try {
          wake()
          maxBacklogTicks = Math.max(maxBacklogTicks, loop.world.tickDiagnostics().backlogTicks)
          loop.afterWake(performance.now() - start < lastCycleAdmissionMilliseconds)
        } catch (error) {
          failed.reject(error)
        }
      }, milliseconds)
      return () => {
        clearInterval(timer)
        timer = undefined
      }
    },
  })
  await Promise.race([setTimeout(durationMilliseconds, undefined, { signal: controller.signal }), failed.promise])
  const elapsedMilliseconds = performance.now() - start
  const metrics = loop.result(12)
  assert.ok(elapsedMilliseconds >= durationMilliseconds)
  assert.ok(Math.abs(metrics.ticks - Math.floor((elapsedMilliseconds * 30) / 1000)) <= 5)
  assert.equal(metrics.backlogTicks, 0)
  assert.equal(backlogEpisodes, backlogRecoveries)
  result = {
    elapsedMilliseconds: Math.round(elapsedMilliseconds),
    node: process.version,
    platform: process.platform,
    osRelease: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramGiB: Math.round(totalmem() / 2 ** 30),
    backlogEpisodes,
    backlogRecoveries,
    maxBacklogTicks,
    ...metrics,
  }
} finally {
  controller.abort()
  process.off('SIGINT', interrupted)
  process.off('SIGTERM', interrupted)
  try {
    loop?.dispose()
    if (result) assert.equal(timer, undefined, 'the world scheduler survived room disposal')
  } finally {
    clearInterval(timer)
  }
}
console.info(JSON.stringify({ ...result, schedulerStopped: true, processFailures: 0 }, null, 2))
