import {
  movementCheckpointMessage,
  ownerGroundLootMessage,
  ownerInventoryMessage,
  ownerLootCommandResultMessage,
  ownerProgressionMessage,
} from '@viesma/protocol'
import { createFixedTickDriver as fixedDriver, step as simulationStep } from '@viesma/simulation'
import { registerHooks } from 'node:module'
import { createHistogram, performance } from 'node:perf_hooks'
import { URL } from 'node:url'

export * from '@viesma/simulation'

const observerUrl = import.meta.url
const runtimeModules = new Set(['world-coordinator', 'map-runtime'].map((name) => new URL(`../dist/runtime/${name}.js`, observerUrl).href))
let observer

export function installObserver(value) {
  observer = value
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@viesma/simulation' && runtimeModules.has(context.parentURL)) {
        return { url: observerUrl, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

export function record(histogram, milliseconds) {
  histogram.record(Math.max(1, Math.round(milliseconds * 1e6)))
}

export function distribution(histogram) {
  if (!histogram.count) return { count: 0 }
  return {
    count: histogram.count,
    p50: histogram.percentile(50) / 1e6,
    p95: histogram.percentile(95) / 1e6,
    p99: histogram.percentile(99) / 1e6,
    max: histogram.max / 1e6,
  }
}

export function counters() {
  return Object.create(null)
}

export function count(target, name, by = 1) {
  target[name] = (target[name] ?? 0) + by
}

export const privateMessages = new Set([
  movementCheckpointMessage,
  ownerGroundLootMessage,
  ownerInventoryMessage,
  ownerLootCommandResultMessage,
  ownerProgressionMessage,
])

export function privateStamp(type, payload) {
  if (type === movementCheckpointMessage) return payload.serverTick
  if (type === ownerGroundLootMessage) return payload.privateRevision
  if (type === ownerLootCommandResultMessage) return JSON.stringify([payload.requestId, payload.code])
  return payload.characterVersion
}

export function matchesOwner(binding, payload) {
  return (
    !!binding &&
    payload.characterId === binding.characterId &&
    payload.mapEpoch === binding.mapEpoch &&
    payload.connectionEpoch === binding.connectionEpoch
  )
}

export function observePrivateWrite(route, type, payload, worldTick) {
  const messages = route.messages.get(type) ?? []
  if (messages.length === 16) messages.shift()
  messages.push({ stamp: privateStamp(type, payload), worldTick })
  route.messages.set(type, messages)
}

export function findAuthorizedInFlight(route, { type, stamp }) {
  if (route?.revokedAt === undefined) return
  return route.messages.get(type)?.find((message) => message.stamp === stamp && message.worldTick < route.revokedAt)
}

export function createFixedTickDriver(clock, onTick, initialTick) {
  const origin = clock.nowMilliseconds()
  const driver = fixedDriver(
    clock,
    (frame) => {
      const started = performance.now()
      onTick(frame)
      const finished = performance.now()
      if (observer.measuring) {
        record(observer.tick, finished - started)
        record(observer.drift, clock.nowMilliseconds() - origin - ((frame.tick - initialTick) * 1000) / 30)
      }
      observer.latestTick = frame.tick
    },
    initialTick
  )
  return {
    advance() {
      const result = driver.advance()
      if (observer.measuring) {
        observer.backlogPeak = Math.max(observer.backlogPeak, result.backlogTicks)
        observer.maxSteps = Math.max(observer.maxSteps, result.steps)
        count(observer.wakes, result.steps)
      }
      return result
    },
  }
}

export function observeCombat(before, after, events, room, incident) {
  let live = 0
  for (const monster of after.monsters) {
    if (monster.hp > 0) live++
    const { spawnId } = monster.spawn
    const previous = room.generations.get(spawnId)
    if (previous !== undefined && monster.generation > previous) count(room.events, 'monsterRespawns')
    room.generations.set(spawnId, monster.generation)
    if (monster.behavior.kind === 'dead' && monster.behavior.startedAt === room.tick) {
      count(room.events, 'monsterDeathsCompleted')
    }
  }
  room.liveMonsters = live
  room.monsters = after.monsters.length
  for (const event of events) {
    count(room.events, event.kind)
    if (
      event.kind === 'monsterDamaged' &&
      !after.monsters.some(({ monsterId, encounterId }) => monsterId === event.monsterId && encounterId === event.encounterId)
    ) {
      incident('stale monster generation received damage')
    }
    if (event.kind === 'playerDamaged') {
      const attacker = after.monsters.find(
        ({ monsterId, encounterId }) => monsterId === event.monsterId && encounterId === event.encounterId
      )
      const target = attacker?.behavior.action?.target
      if (
        target?.characterId !== event.characterId ||
        !after.players.some(
          ({ characterId, lifeStartedTick }) => characterId === target.characterId && lifeStartedTick === target.lifeStartedTick
        )
      ) {
        incident('stale player life received damage')
      }
    }
  }
  for (const player of after.players) {
    if (player.lastAttackStartedTick === room.tick) count(room.events, 'attacksStarted')
    if (player.physics.velocity.y < 0 && before.players.find(({ characterId }) => characterId === player.characterId)?.physics.grounded) {
      count(room.events, 'upwardLaunches')
    }
  }
}

export function step(state, commands, dt, context) {
  const result = simulationStep(state, commands, dt, context)
  const room = observer.rooms.get(state.map.mapInstanceId)
  room.tick = context.tick
  observeCombat(state.map, result.state.map, result.events, room, observer.incident)
  for (const event of result.events) {
    if (event.kind === 'monsterDeathClaimed') observer.audit.deathClaimed(event.intent.claim, room)
  }
  return result
}

export function createRoomMetrics(runtime) {
  return {
    roomId: runtime.roomId,
    mapId: runtime.map.id,
    tickCost: createHistogram(),
    patchCost: createHistogram(),
    generations: new Map(),
    events: counters(),
    input: counters(),
    network: counters(),
    connections: new Map(),
    disconnected: new Set(),
    incoming: new Set(),
    liveMonsters: 0,
    monsters: 0,
    inputDepth: 0,
    queuedInputs: 0,
    queuedInputsPeak: 0,
    activePeak: 0,
    reservedPeak: 0,
    seatsPeak: 0,
    bufferedPeak: 0,
  }
}
