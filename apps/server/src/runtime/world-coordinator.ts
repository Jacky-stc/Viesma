import { toSimulationTick, type MapInstanceId } from '@viesma/domain'
import { monsterMaxHpAtLevel, type GameData } from '@viesma/game-data'
import { createFixedTickDriver, ticksPerSecond, type MonotonicClock } from '@viesma/simulation'
import { createMapRuntime, type MapRuntime } from './map-runtime.ts'

interface WorldDependencies {
  readonly clock: MonotonicClock
  readonly schedule: (wake: () => void, intervalMilliseconds: number) => () => void
  readonly nextId: () => string
  readonly onBacklog: (backlogTicks: number) => void
  readonly onBacklogRecovered?: (recoveryMilliseconds: number, catchUpTicks: number) => void
}

export function createWorldCoordinator(data: GameData, mapContentHash: string, dependencies: WorldDependencies) {
  const map = data.tiledMaps.find(({ id }) => id === 'm1')
  const spawn = map?.spawns.find(({ id }) => id === 'spawn_from_village')
  if (!map || !spawn) throw new RangeError('The development room requires M1 and spawn_from_village')
  const monsterSpawn = map.monsterSpawns.find(({ id }) => id === 'spawn_slime_1')
  const archetype = data.monsters.find(({ id }) => id === monsterSpawn?.monsterArchetypeId)
  if (monsterSpawn?.movement !== 'ground' || !archetype) throw new RangeError('M1 requires a ground monster fixture at spawn_slime_1')
  const fixture = {
    spawn: monsterSpawn,
    patrolSpeed: archetype.patrolSpeed,
    maxHp: Number(monsterMaxHpAtLevel(archetype, monsterSpawn.level, data.monsterScaling)),
  }

  const { clock, schedule, nextId, onBacklog } = dependencies
  const bootId = nextId()
  const rooms = new Map<MapInstanceId, MapRuntime>()
  let stop: (() => void) | undefined
  let tick = toSimulationTick(0)
  let backlogTicks = 0
  let backlogStartedAt: number | undefined
  let catchUpTicks = 0
  let lastBacklogRecoveryMilliseconds: number | undefined
  let instanceSequence = 0

  function start(): void {
    const driver = createFixedTickDriver(
      clock,
      (frame) => {
        for (const id of [...rooms.keys()].sort()) rooms.get(id)?.advance(frame)
        tick = frame.tick
      },
      tick
    )
    stop = schedule(() => {
      const advance = driver.advance()
      backlogTicks = advance.backlogTicks
      catchUpTicks += Math.max(0, advance.steps - 1)
      if (backlogStartedAt === undefined && backlogTicks > 0) {
        backlogStartedAt = clock.nowMilliseconds()
        onBacklog(backlogTicks)
      } else if (backlogStartedAt !== undefined && backlogTicks === 0) {
        lastBacklogRecoveryMilliseconds = clock.nowMilliseconds() - backlogStartedAt
        backlogStartedAt = undefined
        dependencies.onBacklogRecovered?.(lastBacklogRecoveryMilliseconds, catchUpTicks)
      }
    }, 1000 / ticksPerSecond)
  }

  return {
    clock,
    canAdmit: () => backlogTicks === 0,
    tickDiagnostics: () => ({ backlogTicks, catchUpTicks, lastBacklogRecoveryMilliseconds }),
    createRoom(): MapRuntime {
      const mapInstanceId = `${bootId}:${map.id}:${++instanceSequence}` as MapInstanceId
      const room = createMapRuntime(mapInstanceId, map, spawn, mapContentHash, tick, nextId, fixture)
      rooms.set(mapInstanceId, room)
      if (!stop) start()
      return room
    },
    disposeRoom(room: MapRuntime): void {
      if (rooms.get(room.mapInstanceId) !== room) return
      rooms.delete(room.mapInstanceId)
      room.dispose()
      if (rooms.size === 0) {
        stop?.()
        stop = undefined
        backlogTicks = 0
        backlogStartedAt = undefined
      }
    },
  }
}

export type WorldCoordinator = ReturnType<typeof createWorldCoordinator>
