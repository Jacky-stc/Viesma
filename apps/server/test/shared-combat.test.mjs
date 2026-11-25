import { loadGrayboxGameData } from '@viesma/game-data'
import { fixedDeltaSeconds } from '@viesma/simulation'
import { setImmediate } from 'node:timers/promises'
import { expect, test } from 'vitest'
import { createMapRuntime } from '../src/runtime/map-runtime.ts'
import { getMonsterSpawnDefinitions } from '../src/runtime/monster-spawns.ts'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'
import { combatInput, combatPeer, entrySlime, sendCombatInput, sharedCombatData } from './shared-combat-fixture.mjs'
import { createSharedCombatLoop } from './shared-combat-loop.mjs'

const tickMilliseconds = 1000 / 30

test('projects all three archetypes from a validated M2 fixture without adding an online room type', () => {
  const data = loadGrayboxGameData()
  const map = data.tiledMaps.find(({ id }) => id === 'm2')
  const definitions = getMonsterSpawnDefinitions(data, map)
  const create = (spawns, mapInstanceId) => {
    let id = 0
    return createMapRuntime(mapInstanceId, map, map.spawns[0], 'hash', 0, () => `fixture-${++id}`, {
      definitions: spawns,
      maxActive: data.world.maxMonstersPerMap,
    })
  }
  const room = create(definitions, 'fixture-m2')
  const replay = create(definitions.toReversed(), 'replay-m2')
  try {
    const initial = room.snapshot().monsters
    expect(initial).toHaveLength(10)
    expect(new Set(initial.map(({ archetypeId }) => archetypeId))).toEqual(new Set(['slime', 'mushroom', 'bat']))
    expect(initial).toEqual(replay.snapshot().monsters)
    const byId = new Map(
      initial.map(({ monsterId, archetypeId, x, y }) => [
        monsterId,
        definitions.find(({ archetypeId: type, origin }) => type === archetypeId && origin.x === x && origin.y === y),
      ])
    )
    const moved = new Set()
    for (let tick = 1; tick <= 180; tick++) {
      room.advance({ tick, dtSeconds: fixedDeltaSeconds }, tick * tickMilliseconds)
      replay.advance({ tick, dtSeconds: fixedDeltaSeconds }, tick * tickMilliseconds)
      const snapshot = room.snapshot()
      expect(snapshot.monsters).toEqual(replay.snapshot().monsters)
      expect(snapshot.monsters.map(({ monsterId }) => monsterId)).toEqual([...byId.keys()])
      for (const monster of snapshot.monsters) {
        const { origin, bounds, maxHp } = byId.get(monster.monsterId)
        expect(monster).toMatchObject({ y: origin.y, hp: maxHp, generation: 1, state: 'patrol' })
        expect(monster.x).toBeGreaterThanOrEqual(bounds.min.x)
        expect(monster.x).toBeLessThanOrEqual(bounds.max.x)
        if (monster.x !== origin.x) moved.add(monster.monsterId)
      }
    }
    expect(moved).toEqual(new Set(byId.keys()))
  } finally {
    room.dispose()
    replay.dispose()
  }
})

test('four owners land shared hits in stable order, including concurrent lethal swings across two generations', async () => {
  let tick = 0
  let wake
  let id = 0
  const commits = []
  const released = []
  const world = createWorldCoordinator(sharedCombatData(), 'hash', {
    clock: { nowMilliseconds: () => tick * tickMilliseconds + (tick ? 0.0001 : 0) },
    nextId: () => `scenario-${String(++id).padStart(4, '0')}`,
    onBacklog() {},
    schedule(callback) {
      wake = callback
      return () => {
        wake = undefined
      }
    },
    wrapRewardPort: (memory) => ({
      commitReward(intent) {
        const receipt = memory.commitReward(intent)
        commits.push({ intent, receipt })
        return receipt
      },
      releaseReceipt(deathId) {
        released.push(deathId)
        memory.releaseReceipt(deathId)
      },
    }),
  })
  const room = world.createRoom()
  const isolated = world.createRoom()
  const actors = Array.from({ length: 4 }, () => {
    const peer = combatPeer()
    expect(world.join(room, peer)).toBe(true)
    return peer
  })
  const isolatedIds = isolated.snapshot().monsters.map(({ monsterId }) => monsterId)
  const storedIds = new Set()
  const claimedEncounters = new Set()
  const claimedDeaths = new Set()
  const step = (ticks = 1) => {
    for (let step = 0; step < ticks; step++) {
      tick++
      wake()
    }
    expect(room.snapshot().serverTick).toBe(tick)
  }
  try {
    step()
    for (let generation = 1; generation <= 2; generation++) {
      const before = entrySlime(room)
      expect(before).toMatchObject({ hp: 71, generation })
      expect(storedIds.has(before.monsterId)).toBe(false)
      storedIds.add(before.monsterId)

      const opening = actors.at(-1)
      expect(sendCombatInput(world, room, opening, { attackPressed: true })).toBe(true)
      step(4)
      expect(entrySlime(room).hp).toBe(71)
      step()
      expect(entrySlime(room).hp).toBe(51)
      expect(room.combatDamageSince(tick - 1).events).toMatchObject([{ amount: 20, targetId: before.monsterId }])

      const late = combatPeer()
      expect(world.join(room, late)).toBe(true)
      step()
      expect(room.snapshot().players).toHaveLength(5)
      expect(world.checkpoint(room, late.connection).serverTick).toBe(tick)
      expect(entrySlime(room)).toMatchObject({ monsterId: before.monsterId, hp: 51, generation })
      world.leave(room, late.connection)

      const old = actors[1]
      const stale = combatInput(old, { attackPressed: true })
      world.leave(room, old.connection, true)
      expect(world.receive(room, old.connection, stale)).toBe(false)
      step(6)
      expect(room.snapshot().players).toHaveLength(4)
      const next = combatPeer()
      expect(world.reconnect(room, next, old.session.reconnectToken)).toBe(true)
      expect(next.session.characterId).toBe(old.session.characterId)
      expect(next.session.connectionEpoch).not.toBe(old.session.connectionEpoch)
      expect(world.receive(room, next.connection, stale)).toBe(false)
      expect(world.receive(room, next.connection, combatInput(next, { attackPressed: true, hp: 0, damage: 99 }))).toBe(false)
      expect(world.checkpoint(room, old.connection)).toBeUndefined()
      actors[1] = next
      step(11)

      for (const actor of [...actors].reverse()) expect(sendCombatInput(world, room, actor, { attackPressed: true })).toBe(true)
      step(4)
      expect(entrySlime(room).hp).toBe(51)
      step()
      const lethalTick = tick
      expect(entrySlime(room)).toMatchObject({ monsterId: before.monsterId, state: 'rewardPending', hp: 0 })
      expect(room.combatDamageSince(lethalTick - 1).events.map(({ amount, targetId }) => [amount, targetId])).toEqual([
        [20, before.monsterId],
        [20, before.monsterId],
        [11, before.monsterId],
      ])
      expect(commits).toHaveLength(generation - 1)
      step()
      await setImmediate()
      expect(commits).toHaveLength(generation)
      const { intent, receipt } = commits.at(-1)
      const ordered = actors.map(({ session }) => session.characterId)
      expect(ordered).toEqual([...ordered].sort())
      expect(intent.groups.map(({ effectiveDamage, eligibleCharacterIds }) => [effectiveDamage, eligibleCharacterIds])).toEqual([
        [20, [ordered[0]]],
        [20, [ordered[1]]],
        [11, [ordered[2]]],
        [20, [ordered[3]]],
      ])
      expect(intent.claim).toMatchObject({ monsterId: before.monsterId, tick: lethalTick, generation })
      expect(claimedEncounters.has(intent.claim.encounterId)).toBe(false)
      expect(claimedDeaths.has(intent.claim.deathId)).toBe(false)
      claimedEncounters.add(intent.claim.encounterId)
      claimedDeaths.add(intent.claim.deathId)
      expect(receipt.deathId).toBe(intent.claim.deathId)
      expect(receipt.resultingVersions).toHaveLength(4)
      expect(receipt.recipients.reduce((total, { experience }) => total + experience, 0)).toBe(40)
      expect(entrySlime(room).state).toBe('rewardPending')
      step()
      expect(entrySlime(room).state).toBe('dead')
      step(29)
      expect(entrySlime(room).state).toBe('dead')
      step()
      expect(entrySlime(room).state).toBe('respawnWait')
      step(299)
      expect(entrySlime(room).state).toBe('respawnWait')
      step()
      expect(entrySlime(room)).toMatchObject({ hp: 71, generation: generation + 1, state: 'spawning' })
      expect(storedIds.has(entrySlime(room).monsterId)).toBe(false)
      expect(released).toEqual([...claimedDeaths])
      expect(room.combatDamageSince(-1)).toBeUndefined()
      expect(entrySlime(isolated).hp).toBe(71)
      expect(isolated.snapshot().monsters.map(({ monsterId }) => monsterId)).toEqual(isolatedIds)
      step()
    }
  } finally {
    world.disposeRoom(room)
    world.disposeRoom(isolated)
  }
})

test('rehearses two full endurance cycles with a fixed clock and stops the scheduler on disposal', async () => {
  let tick = 0
  let wake
  const loop = createSharedCombatLoop(createWorldCoordinator, {
    clock: { nowMilliseconds: () => tick * tickMilliseconds + (tick ? 0.0001 : 0) },
    onBacklog: (backlog) => expect(backlog).toBe(0),
    schedule(callback) {
      wake = callback
      return () => {
        wake = undefined
      }
    },
  })
  try {
    for (tick = 1; tick <= 1750; tick++) {
      wake()
      loop.afterWake(tick < 850)
      await setImmediate()
    }
    expect(loop.result(2)).toMatchObject({ cycles: 2, ticks: 1750, catchUpTicks: 0 })
  } finally {
    loop.dispose()
  }
  expect(wake).toBeUndefined()
})
