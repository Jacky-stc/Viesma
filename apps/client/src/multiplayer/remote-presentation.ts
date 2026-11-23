import type { WorldPoint } from '@viesma/domain'
import { initialPhysicsBalance } from '@viesma/game-data'
import { positionQuantum } from '@viesma/physics'
import type { PublicMonster, PublicPlayer } from '@viesma/protocol'
import { ticksPerSecond } from '@viesma/simulation'

const millisecondsPerTick = 1000 / ticksPerSecond
const interpolationDelayTicks = 3
const maximumExtrapolationTicks = 3
const maximumSampleGapTicks = 2 * interpolationDelayTicks
const sampleCapacity = 8

interface RemoteIdentity {
  readonly mapInstanceId: string
  readonly mapId: string
  readonly connectionEpoch: string
  readonly mapEpoch: number
}

interface TimedSample<T> {
  readonly tick: number
  readonly value: T
}

type Track<T> = [TimedSample<T>, ...TimedSample<T>[]]

function updateTracks<T>(
  tracks: Map<string, Track<T>>,
  values: readonly T[],
  tick: number,
  idOf: (value: T) => string,
  continuous: (before: T, after: T, deltaTicks: number) => boolean
) {
  const present = new Set<string>()
  for (const value of values) {
    const id = idOf(value)
    present.add(id)
    const track = tracks.get(id)
    const before = track?.at(-1)
    const sample = { tick, value }
    if (!track || !before || tick - before.tick > maximumSampleGapTicks || !continuous(before.value, value, tick - before.tick)) {
      tracks.set(id, [sample])
    } else {
      track.push(sample)
      if (track.length > sampleCapacity) track.shift()
    }
  }
  for (const id of tracks.keys()) {
    if (!present.has(id)) tracks.delete(id)
  }
}

function continuousPlayer(before: PublicPlayer, after: PublicPlayer, deltaTicks: number) {
  const { runSpeedUnitsPerSecond, jumpSpeedUnitsPerSecond, terminalFallSpeedUnitsPerSecond } = initialPhysicsBalance
  const elapsedSeconds = deltaTicks / ticksPerSecond
  // 每 tick 的餘量涵蓋 physics 座標量化。
  const tolerance = deltaTicks * positionQuantum
  return (
    before.mapEpoch === after.mapEpoch &&
    before.lifeStartedTick === after.lifeStartedTick &&
    (before.state === 'death') === (after.state === 'death') &&
    Math.abs(after.x - before.x) <= runSpeedUnitsPerSecond * elapsedSeconds + tolerance &&
    Math.abs(after.y - before.y) <= Math.max(jumpSpeedUnitsPerSecond, terminalFallSpeedUnitsPerSecond) * elapsedSeconds + tolerance
  )
}

function sampleTrack<T extends WorldPoint>(track: Track<T>, tick: number, extrapolationTicks: number) {
  let before = track[0]
  for (const after of track) {
    if (after.tick <= tick) {
      before = after
    } else {
      if (tick <= before.tick) break
      return blend(before, after, tick, 'interpolate', before.value)
    }
  }

  const previous = track.at(-2)
  if (previous && tick > before.tick && extrapolationTicks > 0) {
    const limit = before.tick + extrapolationTicks
    return blend(previous, before, Math.min(tick, limit), tick < limit ? 'extrapolate' : 'hold', before.value)
  }
  return { value: before.value, position: { x: before.value.x, y: before.value.y }, visualTick: before.tick, mode: 'hold' as const }
}

function blend<T extends WorldPoint>(
  before: TimedSample<T>,
  after: TimedSample<T>,
  tick: number,
  mode: 'interpolate' | 'extrapolate' | 'hold',
  value: T
) {
  const alpha = (tick - before.tick) / (after.tick - before.tick)
  return {
    value,
    position: {
      x: before.value.x + (after.value.x - before.value.x) * alpha,
      y: before.value.y + (after.value.y - before.value.y) * alpha,
    },
    visualTick: tick,
    mode,
  }
}

export function createRemotePresentation() {
  const players = new Map<string, Track<PublicPlayer>>()
  const monsters = new Map<string, Track<PublicMonster>>()
  const clockOffsets: number[] = []
  let identity: RemoteIdentity | undefined
  let newestTick = -1
  let visualTick = -interpolationDelayTicks

  function clear() {
    players.clear()
    monsters.clear()
    clockOffsets.length = 0
    identity = undefined
    newestTick = -1
    visualTick = -interpolationDelayTicks
  }

  return {
    receive(
      source: RemoteIdentity,
      tick: number,
      arrivalMilliseconds: number,
      peers: readonly PublicPlayer[],
      sharedMonsters: readonly PublicMonster[]
    ): boolean {
      if (!Number.isSafeInteger(tick) || tick < 0 || !Number.isFinite(arrivalMilliseconds)) return false
      if (
        !identity ||
        source.mapInstanceId !== identity.mapInstanceId ||
        source.mapId !== identity.mapId ||
        source.connectionEpoch !== identity.connectionEpoch ||
        source.mapEpoch !== identity.mapEpoch
      ) {
        clear()
        identity = { ...source }
      }
      if (tick <= newestTick) return false
      if (tick - newestTick > maximumSampleGapTicks) clockOffsets.length = 0
      newestTick = tick
      clockOffsets.push(arrivalMilliseconds - tick * millisecondsPerTick)
      if (clockOffsets.length > sampleCapacity) clockOffsets.shift()

      updateTracks(players, peers, tick, (player) => player.characterId, continuousPlayer)
      updateTracks(
        monsters,
        sharedMonsters,
        tick,
        (monster) => monster.monsterId,
        (before, after) => before.archetypeId === after.archetypeId
      )
      return true
    },
    sample(nowMilliseconds: number) {
      if (clockOffsets.length > 0) {
        const estimatedTick = (nowMilliseconds - Math.min(...clockOffsets)) / millisecondsPerTick
        visualTick = Math.max(visualTick, Math.min(estimatedTick - interpolationDelayTicks, newestTick + maximumExtrapolationTicks))
      }
      return {
        peers: new Map(
          Array.from(players, ([id, track]) => {
            const canExtrapolate = track.at(-1)?.value.state !== 'death'
            const {
              position,
              value,
              visualTick: tick,
              mode,
            } = sampleTrack(track, visualTick, canExtrapolate ? maximumExtrapolationTicks : 0)
            return [id, { position, visualTick: tick, state: value.state, facing: value.facing, mode }]
          })
        ),
        monsters: new Map(
          Array.from(monsters, ([id, track]) => {
            const { position, value, visualTick: tick } = sampleTrack(track, visualTick, 0)
            return [id, { position, visualTick: tick, archetypeId: value.archetypeId, facing: value.facing }]
          })
        ),
      }
    },
    diagnostics: () => ({
      clockSamples: clockOffsets.length,
      players: Array.from(players, ([id, track]) => [id, track.length]),
      monsters: Array.from(monsters, ([id, track]) => [id, track.length]),
    }),
    clear,
  }
}
