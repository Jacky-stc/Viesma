import type { WorldPoint } from '@viesma/domain'
import { initialPhysicsBalance, type NormalizedMap } from '@viesma/game-data'

export const hardCorrectionWorldUnits = 64
const correctionMilliseconds = 100

function axisInterval(start: number, end: number, min: number, max: number): readonly [number, number] | undefined {
  const distance = end - start
  if (distance === 0) return start > min && start < max ? [-Infinity, Infinity] : undefined
  const enter = (min - start) / distance
  const exit = (max - start) / distance
  return [Math.min(enter, exit), Math.max(enter, exit)]
}

/** 以角色 AABB 擴張 solid 後，檢查整段畫面校正路徑。碰到邊緣仍可沿面移動。 */
export function correctionPathIsClear(map: NormalizedMap, from: WorldPoint, to: WorldPoint): boolean {
  const { bodyWidthWorldUnits: width, bodyHeightWorldUnits: height } = initialPhysicsBalance
  const { origin, width: worldWidth } = map.bounds
  if (to.x < origin.x || to.x + width > origin.x + worldWidth || to.y < origin.y) return false
  return !map.colliders.some(({ kind, bounds }) => {
    if (kind !== 'solid') return false
    const { x, y } = bounds.origin
    const horizontal = axisInterval(from.x, to.x, x - width, x + bounds.width)
    const vertical = axisInterval(from.y, to.y, y - height, y + bounds.height)
    return horizontal && vertical && Math.max(0, horizontal[0], vertical[0]) < Math.min(1, horizontal[1], vertical[1])
  })
}

export function createCorrectionPresentation(map: NormalizedMap) {
  let offset: { x: number; y: number; startedAt: number } | undefined

  function positionAt(position: WorldPoint, now: number): WorldPoint {
    if (!offset) return position
    const weight = Math.min(1, Math.max(0, 1 - (now - offset.startedAt) / correctionMilliseconds))
    const blended = { x: position.x + offset.x * weight, y: position.y + offset.y * weight }
    if (weight > 0 && correctionPathIsClear(map, position, blended)) return blended
    offset = undefined
    return position
  }

  return {
    positionAt,
    correct(before: WorldPoint, after: WorldPoint, now: number) {
      const shown = positionAt(before, now)
      const x = shown.x - after.x
      const y = shown.y - after.y
      if (Math.hypot(x, y) > hardCorrectionWorldUnits || !correctionPathIsClear(map, after, shown)) {
        offset = undefined
        return false
      }
      offset = { x, y, startedAt: now }
      return true
    },
    reset() {
      offset = undefined
    },
  }
}
