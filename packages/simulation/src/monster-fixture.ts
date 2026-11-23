import { fixedDeltaSeconds, type MonsterId, type WorldPoint } from '@viesma/domain'
import type { MapMonsterSpawn, MonsterArchetypeId } from '@viesma/game-data'
import { positionQuantum } from '@viesma/physics'
import type { FacingDirection } from './player.js'

export interface MonsterFixtureDefinition {
  readonly spawn: Extract<MapMonsterSpawn, { movement: 'ground' }>
  readonly patrolSpeed: number
  readonly maxHp: number
}

export interface MonsterFixture {
  readonly monsterId: MonsterId
  readonly archetypeId: MonsterArchetypeId
  /** 以通過 Tiled 驗證的巡邏區間為準，位置使用腳底中心。 */
  readonly position: WorldPoint
  readonly facing: FacingDirection
  readonly hp: number
  readonly maxHp: number
  readonly patrol: { readonly minX: number; readonly maxX: number; readonly speed: number }
}

export type MonsterFixtureEvent = 'test-hp' | 'remove'

export function createMonsterFixture(monsterId: MonsterId, { spawn, patrolSpeed, maxHp }: MonsterFixtureDefinition): MonsterFixture {
  return {
    monsterId,
    archetypeId: spawn.monsterArchetypeId,
    position: { ...spawn.position },
    facing: spawn.position.x < spawn.patrolMaxX ? 'right' : 'left',
    hp: maxHp,
    maxHp,
    patrol: { minX: spawn.patrolMinX, maxX: spawn.patrolMaxX, speed: patrolSpeed },
  }
}

export function stepMonsterFixture(monster: MonsterFixture, events: ReadonlySet<MonsterFixtureEvent>): MonsterFixture | undefined {
  if (events.has('remove')) return undefined

  const { position, patrol } = monster
  const width = patrol.maxX - patrol.minX
  const offset = position.x - patrol.minX
  const phase = monster.facing === 'right' ? offset : 2 * width - offset
  const next = (phase + patrol.speed * fixedDeltaSeconds) % (2 * width)
  const facing = next < width ? 'right' : 'left'
  const x = patrol.minX + (facing === 'right' ? next : 2 * width - next)
  return {
    ...monster,
    position: { x: Math.round(x / positionQuantum) * positionQuantum, y: position.y },
    facing,
    hp: events.has('test-hp') ? Math.max(1, Math.floor(monster.maxHp / 2)) : monster.hp,
  }
}
