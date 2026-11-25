import { fixedDeltaSeconds, type DeathId, type SimulationTick, type WorldPoint } from '@viesma/domain'
import { initialMonsterAiBalance as balance } from '@viesma/game-data'
import { positionQuantum, type SolidPointSweep } from '@viesma/physics'
import {
  spawnFacing,
  spawnMonster,
  type MonsterAggro,
  type MonsterDeathIdentity,
  type MonsterIds,
  type MonsterTarget,
  type SimulationMonster,
} from './monster.js'
import { playerFeet, type SimulationPlayer } from './player.js'
import type { RandomSource } from './random.js'

export interface MonsterStepContext extends MonsterIds {
  readonly move: SolidPointSweep
  readonly receiptFor?: (deathId: DeathId) => MonsterDeathIdentity | undefined
}

interface TargetCandidate extends MonsterTarget {
  readonly position: WorldPoint
}

function distanceSquared(a: WorldPoint, b: WorldPoint): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

export function monsterCanReach(monster: SimulationMonster, position: WorldPoint): boolean {
  return distanceSquared(monster.position, position) <= monster.spawn.attackReach ** 2
}

function clampToPatrol(point: WorldPoint, { spawn }: SimulationMonster): WorldPoint {
  const { min, max } = spawn.bounds
  return { x: Math.max(min.x, Math.min(max.x, point.x)), y: Math.max(min.y, Math.min(max.y, point.y)) }
}

function findTarget(targets: readonly TargetCandidate[], ref: MonsterTarget | null): TargetCandidate | undefined {
  return ref === null
    ? undefined
    : targets.find(({ characterId, lifeStartedTick }) => characterId === ref.characterId && lifeStartedTick === ref.lifeStartedTick)
}

function targetRef({ characterId, lifeStartedTick }: TargetCandidate): MonsterTarget {
  return { characterId, lifeStartedTick }
}

function selectTarget(
  monster: SimulationMonster,
  targets: readonly TargetCandidate[],
  current: TargetCandidate | undefined
): TargetCandidate | undefined {
  let nearest: TargetCandidate | undefined
  let nearestDistance = Infinity
  for (const target of targets) {
    const distance = distanceSquared(monster.position, target.position)
    if (distance > (target === current ? balance.loseTargetRadius : balance.aggroRadius) ** 2) continue
    if (
      target !== current &&
      (distanceSquared(monster.spawn.origin, target.position) > balance.spawnLeash ** 2 ||
        distanceSquared(clampToPatrol(target.position, monster), target.position) > monster.spawn.attackReach ** 2)
    ) {
      continue
    }
    // step 依 characterId 排好 players，等距時保留先出現的角色。
    if (distance >= nearestDistance) continue
    nearest = target
    nearestDistance = distance
  }
  return nearest
}

function moveToward(monster: SimulationMonster, destination: WorldPoint, speed: number, move: SolidPointSweep): SimulationMonster {
  const { position } = monster
  const distance = Math.sqrt(distanceSquared(position, destination))
  if (distance === 0) return monster
  const step = speed * fixedDeltaSeconds
  const ratio = Math.min(1, step / distance)
  let next = move(position, {
    x: position.x + (destination.x - position.x) * ratio,
    y: position.y + (destination.y - position.y) * ratio,
  })
  // 完全受阻的一軸不再佔用本 tick 的位移，另一軸可沿碰撞面滑動。
  if (next.x === position.x && destination.x !== position.x && next.y !== destination.y) {
    const dy = destination.y - position.y
    next = move(position, { x: position.x, y: position.y + Math.sign(dy) * Math.min(Math.abs(dy), step) })
  } else if (next.y === position.y && destination.y !== position.y && next.x !== destination.x) {
    const dx = destination.x - position.x
    next = move(position, { x: position.x + Math.sign(dx) * Math.min(Math.abs(dx), step), y: position.y })
  }
  return {
    ...monster,
    position: next,
    facing: next.x === position.x ? monster.facing : next.x > position.x ? 'right' : 'left',
  }
}

function patrol(monster: SimulationMonster, move: SolidPointSweep): SimulationMonster {
  const { position, spawn } = monster
  const minX = spawn.bounds.min.x
  const width = spawn.bounds.max.x - minX
  const offset = position.x - minX
  const phase = monster.facing === 'right' ? offset : 2 * width - offset
  const next = (phase + spawn.patrolSpeed * fixedDeltaSeconds) % (2 * width)
  const facing = next < width ? 'right' : 'left'
  const x = minX + (facing === 'right' ? next : 2 * width - next)
  const advanced = move(position, { x, y: position.y })
  const blocked = advanced.x === position.x && Math.abs(x - position.x) >= positionQuantum
  return {
    ...monster,
    position: advanced,
    facing: blocked ? (x > position.x ? 'left' : 'right') : facing,
    behavior: { kind: 'patrol' },
  }
}

function startReturn(monster: SimulationMonster): SimulationMonster {
  return { ...monster, behavior: { kind: 'return' } }
}

function advanceReturn(
  monster: SimulationMonster,
  tick: SimulationTick,
  context: MonsterStepContext,
  rng: RandomSource
): SimulationMonster {
  const { spawn } = monster
  const advanced = moveToward(monster, spawn.origin, spawn.chaseSpeed, context.move)
  if (distanceSquared(advanced.position, spawn.origin) !== 0) return advanced
  return {
    ...advanced,
    hp: spawn.maxHp,
    encounterId: context.nextEncounterId(),
    encounterResetTick: tick,
    ledger: null,
    behavior: { kind: 'patrol' },
    lastAttackStartedTick: null,
    facing: spawnFacing(spawn, rng),
  }
}

function chase(
  monster: SimulationMonster,
  aggro: MonsterAggro,
  target: TargetCandidate | undefined,
  tick: SimulationTick,
  move: SolidPointSweep
): SimulationMonster {
  if (
    distanceSquared(monster.position, monster.spawn.origin) > balance.spawnLeash ** 2 ||
    (aggro.lostAt !== null && tick - aggro.lostAt >= balance.targetLossTicks)
  ) {
    return startReturn(monster)
  }

  const chasing: SimulationMonster = { ...monster, behavior: { kind: 'chase', aggro } }
  if (!target) return chasing
  if (monsterCanReach(monster, target.position)) {
    if (monster.lastAttackStartedTick !== null && tick - monster.lastAttackStartedTick < balance.cooldownTicks) return chasing
    return {
      ...monster,
      facing: target.position.x === monster.position.x ? monster.facing : target.position.x > monster.position.x ? 'right' : 'left',
      lastAttackStartedTick: tick,
      behavior: { kind: 'attack', aggro, startedAt: tick, action: { phase: 'windup', target: targetRef(target) } },
    }
  }

  const destination = clampToPatrol(target.position, monster)
  const advanced = moveToward(chasing, destination, monster.spawn.chaseSpeed, move)
  if (
    distanceSquared(advanced.position, monster.position) === 0 ||
    distanceSquared(advanced.position, monster.spawn.origin) > balance.spawnLeash ** 2
  ) {
    return startReturn(chasing)
  }
  return advanced
}

function advanceMonster(
  monster: SimulationMonster,
  targets: readonly TargetCandidate[],
  tick: SimulationTick,
  context: MonsterStepContext,
  rng: RandomSource
): SimulationMonster {
  const { behavior } = monster
  if (behavior.kind === 'rewardPending') {
    const receipt = context.receiptFor?.(behavior.deathId)
    if (
      receipt?.deathId !== behavior.deathId ||
      receipt.monsterId !== monster.monsterId ||
      receipt.generation !== monster.generation ||
      receipt.encounterId !== monster.encounterId
    )
      return monster
    return { ...monster, behavior: { kind: 'dead', deathId: behavior.deathId, startedAt: tick } }
  }
  if (behavior.kind === 'dead') {
    if (tick - behavior.startedAt < balance.corpseTicks) return monster
    return { ...monster, behavior: { kind: 'respawnWait', deathId: behavior.deathId, startedAt: tick } }
  }
  if (behavior.kind === 'respawnWait') {
    if (tick - behavior.startedAt < balance.respawnWaitTicks) return monster
    return spawnMonster(monster.spawn, context, rng, monster.generation + 1, tick)
  }
  if (behavior.kind === 'return') return advanceReturn(monster, tick, context, rng)
  if (behavior.kind === 'spawning') return patrol(monster, context.move)

  const prior = behavior.kind === 'chase' || behavior.kind === 'attack' ? behavior.aggro : undefined
  const retained = findTarget(targets, prior?.target ?? null)
  const current = retained && distanceSquared(monster.position, retained.position) <= balance.loseTargetRadius ** 2 ? retained : undefined
  const target = tick % balance.targetScanTicks === 0 ? selectTarget(monster, targets, current) : current
  if (behavior.kind === 'patrol' && !target) return patrol(monster, context.move)

  const aggro: MonsterAggro = target ? { target: targetRef(target), lostAt: null } : { target: null, lostAt: prior?.lostAt ?? tick }
  if (behavior.kind === 'attack') {
    const elapsed = tick - behavior.startedAt
    const ref = behavior.action.phase === 'recovery' ? null : behavior.action.target
    const locked = findTarget(targets, ref)
    if (elapsed < balance.windupTicks) {
      return { ...monster, behavior: { ...behavior, aggro, action: { phase: 'windup', target: locked ? ref : null } } }
    }
    if (elapsed < balance.windupTicks + balance.activeTicks) {
      const candidate = locked && monsterCanReach(monster, locked.position) ? ref : null
      return { ...monster, behavior: { ...behavior, aggro, action: { phase: 'active', target: candidate } } }
    }
    if (elapsed < balance.windupTicks + balance.activeTicks + balance.recoveryTicks) {
      return { ...monster, behavior: { ...behavior, aggro, action: { phase: 'recovery' } } }
    }
  }
  return chase(monster, aggro, target, tick, context.move)
}

export function advanceMonsters(
  monsters: readonly SimulationMonster[],
  players: readonly SimulationPlayer[],
  tick: SimulationTick,
  context: MonsterStepContext | undefined,
  rng: RandomSource
): readonly SimulationMonster[] {
  if (monsters.length === 0) return monsters
  if (!context) throw new RangeError('Simulation step requires monster context for maps with monsters')
  const targets: TargetCandidate[] = players
    .filter(({ action, vitals, spawnProtected }) => action.kind !== 'death' && vitals.hp > 0 && !spawnProtected)
    .map((player) => ({
      characterId: player.characterId,
      lifeStartedTick: player.lifeStartedTick,
      position: playerFeet(player),
    }))
  return monsters
    .map((monster) => advanceMonster(monster, targets, tick, context, rng))
    .sort((a, b) => (a.monsterId < b.monsterId ? -1 : Number(a.monsterId > b.monsterId)))
}
