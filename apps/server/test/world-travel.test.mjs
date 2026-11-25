import { loadGrayboxGameData } from '@viesma/game-data'
import { PROTOCOL_VERSION } from '@viesma/protocol'
import { findOverlappingPortal } from '@viesma/simulation'
import { setImmediate } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'
import { movementSmokeData, movementSmokeMaxPlayerX } from './movement-smoke-fixture.mjs'
import { combatPeer, sendCombatInput } from './shared-combat-fixture.mjs'

function harness(createDestination, data = loadGrayboxGameData(), dependencies = {}) {
  let now = 0
  let id = 0
  let wake
  const world = createWorldCoordinator(data, 'hash', {
    clock: { nowMilliseconds: () => now },
    nextId: () => `id-${++id}`,
    schedule(callback) {
      wake = callback
      return () => {
        wake = undefined
      }
    },
    onBacklog: vi.fn(),
    createDestination,
    ...dependencies,
  })
  return {
    world,
    advance(milliseconds = 34) {
      now += milliseconds
      wake?.()
    },
    setNow(milliseconds) {
      now += milliseconds
    },
  }
}

function peer() {
  return { connection: {}, joined: vi.fn(), offer: vi.fn(), failed: vi.fn(), close: vi.fn() }
}

const session = (peer) => peer.joined.mock.lastCall[0]
const offer = (peer) => peer.offer.mock.lastCall[0]
const body = (room, peer) => room.player(session(peer).characterId)

test('isolates the smoke jump from a real entrance Slime hit while preserving the shared monsters', () => {
  const paths = [loadGrayboxGameData(), movementSmokeData()].map((data) => {
    const { world, advance } = harness(undefined, data)
    const room = world.createRoom()
    const traveler = combatPeer()
    expect(world.join(room, traveler)).toBe(true)
    advance()
    return { world, room, traveler, advance, player: () => room.player(traveler.session.characterId) }
  })
  const [original, movement] = paths
  const monsters = ({ room }) => room.snapshot().monsters.map(({ monsterId, archetypeId, hp }) => ({ monsterId, archetypeId, hp }))
  expect(monsters(movement)).toHaveLength(10)
  expect(monsters(movement)).toEqual(monsters(original))

  function step(input) {
    for (const { world, room, traveler, advance } of paths) {
      expect(sendCombatInput(world, room, traveler, input)).toBe(true)
      advance()
    }
  }

  for (let tick = 0; tick < 24; tick++) step({ moveX: 1 })
  for (let tick = 0; tick < 8; tick++) step({})
  expect(movement.player().position).toEqual(original.player().position)
  expect(movement.player().position.x).toBeLessThan(movementSmokeMaxPlayerX)
  const lastHit = original.player().lastHurtTick
  for (let tick = 0; tick < 36 && original.player().lastHurtTick === lastHit; tick++) step({})
  expect(original.player()).toMatchObject({
    lastHurtTick: original.room.snapshot().serverTick,
    position: { y: 848 },
    physics: { grounded: true },
    action: { kind: 'hurt', ticksRemaining: 6 },
  })

  step({ jumpPressed: true })
  expect(original.player()).toMatchObject({
    position: { y: 848 },
    movement: { lastProcessedInputSeq: original.traveler.seq, jumpBufferTicksRemaining: 0 },
    action: { kind: 'hurt', ticksRemaining: 5 },
  })
  expect(movement.player()).toMatchObject({
    vitals: { hp: 50 },
    physics: { grounded: false },
    movement: { lastProcessedInputSeq: movement.traveler.seq },
    locomotion: 'jump',
  })
  expect(movement.player().position.y).toBeLessThan(833)
  expect(monsters(movement)).toEqual(monsters(original))
  for (const { world, room } of paths) world.disposeRoom(room)
})

function dataWithSpawnNearSlime() {
  const data = loadGrayboxGameData()
  const tiledMaps = data.tiledMaps.map((map) =>
    map.id === 'm1'
      ? {
          ...map,
          spawns: map.spawns.map((spawn) => (spawn.id === 'spawn_from_village' ? { ...spawn, position: { x: 453, y: 848 } } : spawn)),
        }
      : map
  )
  return { ...data, tiledMaps }
}

test('damages a grace-disconnected body until expiry and never respawns monsters on reconnect', () => {
  const { world, advance, setNow } = harness(undefined, dataWithSpawnNearSlime())
  const room = world.createRoom()
  const empty = world.createRoom()
  const original = peer()
  const initial = room.snapshot().monsters
  const { monsterId } = initial.find(({ x, y }) => x === 465 && y === 896)
  const emptyId = empty.snapshot().monsters.find(({ x, y }) => x === 465 && y === 896).monsterId
  const slime = (room, id) => room.snapshot().monsters.find((monster) => monster.monsterId === id)
  const ids = () => room.snapshot().monsters.map(({ monsterId }) => monsterId)
  expect(world.join(room, original)).toBe(true)
  advance()
  const { characterId } = session(original)
  world.leave(room, original.connection, true)
  // 第 6 tick 開始前搖。第 15 tick 的有效階段仍可傷害 grace body。
  for (let tick = 2; tick <= 15; tick++) advance()
  expect(room.snapshot().serverTick).toBe(15)
  expect(room.player(characterId)).toMatchObject({ vitals: { hp: 43 }, action: { kind: 'hurt', ticksRemaining: 6 } })
  expect(slime(room, monsterId).x).toBe(475)
  expect(slime(empty, emptyId).x).toBe(495)
  expect(ids()).toEqual(initial.map(({ monsterId }) => monsterId))

  let recovery = original
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = peer()
    expect(world.reconnect(room, next, session(recovery).reconnectToken)).toBe(true)
    expect(session(next).characterId).toBe(characterId)
    expect(body(room, next).vitals.hp).toBe(43)
    expect(ids()).toEqual(initial.map(({ monsterId }) => monsterId))
    world.leave(room, next.connection, true)
    recovery = next
  }
  setNow(29_999)
  advance(0)
  expect(room.player(characterId)).toBeDefined()
  advance(1)
  expect(room.player(characterId)).toBeUndefined()
  expect(world.reconnect(room, peer(), session(recovery).reconnectToken)).toBe(false)
  for (let wake = 0; wake < 21; wake++) advance(0)
  expect(slime(room, monsterId).x).not.toBe(475)
  expect(ids()).toEqual(initial.map(({ monsterId }) => monsterId))
  world.disposeRoom(room)
  world.disposeRoom(empty)
})

test('a lethal monster hit uses the existing 90-tick Village respawn handoff', () => {
  const { world, advance } = harness(undefined, dataWithSpawnNearSlime())
  const room = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  expect(world.join(room, source)).toBe(true)
  advance()
  function advanceTo(tick) {
    while (room.snapshot().serverTick < tick) advance(1000 / 30)
    expect(room.snapshot().serverTick).toBe(tick)
  }
  const player = body(room, source)
  room.respawn(source.connection, { ...player, vitals: { ...player.vitals, hp: 7 } })
  advanceTo(14)
  expect(body(room, source).vitals.hp).toBe(7)
  advanceTo(15)
  expect(body(room, source)).toMatchObject({ vitals: { hp: 0 }, action: { kind: 'death', diedAtTick: 15 } })
  advanceTo(104)
  expect(source.offer).not.toHaveBeenCalled()
  expect(request(world, room, source)).toBe(true)
  advanceTo(105)
  expect(source.failed).toHaveBeenCalledExactlyOnceWith({ requestId: 1, code: 'PORTAL_UNAVAILABLE' })
  expect(source.offer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: null, mapId: 'village', mapEpoch: 1 }))
  const destination = peer()
  expect(claim(world, village, source, destination)).toBe(true)
  advanceTo(106)
  expect(room.player(player.characterId)).toBeUndefined()
  expect(body(village, destination)).toMatchObject({
    lifeStartedTick: 106,
    vitals: { hp: 50, mp: 30 },
    spawnProtected: true,
    action: { kind: 'none' },
  })
  expect(claim(world, village, source, peer())).toBe(false)
  advanceTo(195)
  expect(village.snapshot().players).toMatchObject([{ spawnProtected: true, hp: 50 }])
  advanceTo(196)
  expect(village.snapshot().players).toMatchObject([{ spawnProtected: false, hp: 50 }])
  expect(village.snapshot().monsters).toEqual([])
  expect(body(village, destination).vitals).toMatchObject({ hp: 50, mp: 30 })
  expect(destination.joined).toHaveBeenCalledOnce()
  expect(source.offer).toHaveBeenCalledOnce()
})

test('simultaneous recoveries share one new Village when the existing instance is full', async () => {
  let overflow
  const createDestination = vi.fn((mapId) => {
    overflow = world.createRoom(mapId)
  })
  const { world, advance } = harness(createDestination, dataWithSpawnNearSlime())
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const players = [peer(), peer()]
  for (let index = 0; index < 20; index++) expect(world.join(village, peer())).toBe(true)
  for (const player of players) expect(world.join(m1, player)).toBe(true)
  advance()
  // 排入同一個 Death tick，專門驗證滿房時的 reservation 與交接。
  for (const player of players) {
    const live = body(m1, player)
    m1.respawn(player.connection, { ...live, vitals: { ...live.vitals, hp: 0 }, action: { kind: 'death', diedAtTick: 1 } })
  }
  while (m1.snapshot().serverTick < 91) advance(1000 / 30)
  await setImmediate()
  expect(createDestination).toHaveBeenCalledExactlyOnceWith('village')
  expect(village.snapshot().players).toHaveLength(20)
  advance(1000 / 30)
  const candidates = players.map((player) => {
    expect(player.failed).not.toHaveBeenCalled()
    expect(player.offer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: null, roomId: overflow.roomId }))
    const candidate = peer()
    expect(claim(world, overflow, player, candidate)).toBe(true)
    return candidate
  })
  advance(1000 / 30)
  expect(m1.snapshot().players).toEqual([])
  expect(
    overflow
      .snapshot()
      .players.map(({ characterId }) => characterId)
      .sort()
  ).toEqual(players.map((player) => session(player).characterId).sort())
  for (const [index, candidate] of candidates.entries()) {
    expect(candidate.joined).toHaveBeenCalledOnce()
    expect(body(overflow, candidate)).toMatchObject({ vitals: { hp: 50, mp: 30 }, spawnProtected: true })
    expect(claim(world, overflow, players[index], peer())).toBe(false)
    expect(players[index].close).toHaveBeenCalledOnce()
  }
  world.disposeRoom(m1)
  world.disposeRoom(village)
  world.disposeRoom(overflow)
})

function walkToPortal({ world, advance }, room, ...peers) {
  advance()
  for (let seq = 1; seq <= 30; seq++) {
    if (peers.every((peer) => findOverlappingPortal(room.map, body(room, peer).position))) return
    for (const peer of peers) {
      const { connectionEpoch, mapEpoch } = session(peer)
      expect(
        world.receive(room, peer.connection, {
          protocolVersion: PROTOCOL_VERSION,
          connectionEpoch,
          mapEpoch,
          seq,
          moveX: -1,
          jumpPressed: false,
          attackPressed: false,
        })
      ).toBe(true)
    }
    advance()
  }
  throw new Error('The fixture did not reach the portal')
}

function request(world, room, peer, requestId = 1, overrides = {}) {
  return world.requestPortal(room, peer.connection, {
    requestId,
    mapEpoch: session(peer).mapEpoch,
    objectId: room.map.id === 'm1' ? 'p_to_village' : 'p_to_m1',
    ...overrides,
  })
}

function claim(world, room, source, candidate, token = session(source).reconnectToken) {
  return world.acceptTransfer(room, candidate, offer(source).ticket, token)
}

function rewardHarness(createCommit = (memory) => vi.fn(memory.commitReward)) {
  const data = loadGrayboxGameData()
  const tiledMaps = data.tiledMaps.map((map) =>
    map.id === 'm1'
      ? {
          ...map,
          spawns: map.spawns.map((spawn) => (spawn.id === 'spawn_from_village' ? { ...spawn, position: { x: 411, y: 848 } } : spawn)),
          monsterSpawns: map.monsterSpawns
            .filter(({ id }) => id === 'spawn_slime_1')
            .map((spawn) => ({ ...spawn, patrolMinX: 464, patrolMaxX: 466 })),
          portals: map.portals.map((portal) =>
            portal.id === 'p_to_village' ? { ...portal, bounds: { ...portal.bounds, origin: { x: 411, y: 848 } } } : portal
          ),
        }
      : map
  )
  let rewardPort
  const h = harness(
    undefined,
    { ...data, tiledMaps },
    {
      wrapRewardPort(memory) {
        rewardPort = { commitReward: createCommit(memory), releaseReceipt: vi.fn(memory.releaseReceipt) }
        return rewardPort
      },
      partyMembership: (id) => ({ kind: 'party', partyId: 'shared', membershipToken: `tenure:${id}` }),
    }
  )
  const room = h.world.createRoom()
  function advanceTo(tick) {
    while (room.snapshot().serverTick < tick) h.advance(1000 / 30 + 0.0001)
    expect(room.snapshot().serverTick).toBe(tick)
  }
  function attack(peer, seq) {
    const { connectionEpoch, mapEpoch } = session(peer)
    expect(
      h.world.receive(room, peer.connection, {
        protocolVersion: PROTOCOL_VERSION,
        connectionEpoch,
        mapEpoch,
        seq,
        moveX: 0,
        jumpPressed: false,
        attackPressed: true,
      })
    ).toBe(true)
  }
  return { ...h, room, advanceTo, attack, rewardPort }
}

test('a claimed portal ticket is invalidated when the source has an authoritative Death', () => {
  const { world, room, advanceTo } = rewardHarness()
  const village = world.createRoom('village')
  const source = peer()
  world.join(room, source)
  advanceTo(1)
  expect(request(world, room, source)).toBe(true)
  advanceTo(2)
  const ticket = offer(source).ticket
  const portalCandidate = peer()
  expect(claim(world, village, source, portalCandidate)).toBe(true)
  const original = body(room, source)
  // 注入提交前已確認的死亡，驗證過期票券與目的席位的清理。
  room.respawn(source.connection, { ...original, action: { kind: 'death', diedAtTick: 2 }, vitals: { ...original.vitals, hp: 0, mp: 5 } })
  advanceTo(3)
  expect(portalCandidate.joined).not.toHaveBeenCalled()
  expect(portalCandidate.close).toHaveBeenCalledOnce()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(world.acceptTransfer(village, peer(), ticket, session(source).reconnectToken)).toBe(false)
  expect(body(room, source).action.kind).toBe('death')
  advanceTo(91)
  expect(source.offer).toHaveBeenCalledOnce()
  advanceTo(92)
  expect(offer(source)).toMatchObject({ requestId: null, mapEpoch: 1 })
  expect(offer(source).ticket).not.toBe(ticket)
  const recovery = peer()
  expect(claim(world, village, source, recovery)).toBe(true)
  advanceTo(93)
  world.leave(room, source.connection, true)
  world.leave(village, portalCandidate.connection, true)
  advanceTo(100)
  expect(room.snapshot().players).toEqual([])
  expect(village.snapshot().players).toMatchObject([{ characterId: original.characterId, lifeStartedTick: 93, hp: 50 }])
  expect(body(village, recovery).vitals.mp).toBe(30)
  expect(recovery.joined).toHaveBeenCalledOnce()
  expect(source.offer).toHaveBeenCalledTimes(2)
})

test('projects RewardPending through failure and lost acknowledgment, then applies the receipt once on a fixed tick', async () => {
  const confirmation = Promise.withResolvers()
  let cachedReceipt
  const { world, room, advanceTo, attack, rewardPort } = rewardHarness((memory) =>
    vi
      .fn()
      .mockRejectedValueOnce(new Error('before commit'))
      .mockImplementationOnce((intent) => {
        cachedReceipt = memory.commitReward(intent)
        return Promise.reject(new Error('acknowledgment lost'))
      })
      .mockImplementation((intent) => confirmation.promise.then(() => memory.commitReward(intent)))
  )
  const killer = peer()
  const joiner = peer()
  world.join(room, killer)
  advanceTo(1)
  const original = room.snapshot().monsters[0]
  for (let seq = 1; seq <= 4; seq++) {
    attack(killer, seq)
    advanceTo(room.snapshot().serverTick + 18)
  }
  const pending = { monsterId: original.monsterId, generation: original.generation, state: 'rewardPending', hp: 0 }
  const expectPending = () => expect(room.snapshot().monsters[0]).toMatchObject(pending)
  const flush = async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve()
  }
  expectPending()
  await flush()
  advanceTo(74)
  await flush()
  expect(cachedReceipt).toBeDefined()
  expectPending()
  advanceTo(75)
  await flush()
  expect(rewardPort.commitReward).toHaveBeenCalledTimes(3)
  expect(rewardPort.commitReward.mock.calls.every(([intent]) => intent === rewardPort.commitReward.mock.calls[0][0])).toBe(true)
  world.join(room, joiner)
  advanceTo(200)
  expectPending()
  expect(room.combatDamageSince(199)).toBeUndefined()
  confirmation.resolve()
  confirmation.resolve()
  await flush()
  expectPending()
  advanceTo(201)
  expect(room.snapshot().monsters[0]).toMatchObject({ monsterId: original.monsterId, state: 'dead', hp: 0 })
  advanceTo(230)
  expect(room.snapshot().monsters[0].state).toBe('dead')
  advanceTo(231)
  expect(room.snapshot().monsters[0].state).toBe('respawnWait')
  advanceTo(530)
  expect(room.snapshot().monsters[0].state).toBe('respawnWait')
  advanceTo(531)
  const next = room.snapshot().monsters[0]
  expect(next).toMatchObject({ generation: 2, state: 'spawning', hp: 71 })
  expect(next.monsterId).not.toBe(original.monsterId)
  expect(rewardPort.releaseReceipt).toHaveBeenCalledExactlyOnceWith(cachedReceipt.deathId)
  advanceTo(532)
  expect(room.snapshot().monsters).toMatchObject([{ monsterId: next.monsterId, generation: 2, hp: 71, state: 'patrol' }])
})

test.each(['disconnected', 'reconnected', 'transferring', 'transferred', 'expired'])(
  'freezes eligibility from the authoritative room when a first-hit contributor is %s',
  async (status) => {
    const { world, room, advanceTo, attack, rewardPort } = rewardHarness()
    const origin = peer()
    const finisher = peer()
    const village = world.createRoom('village')
    const independent = world.createRoom()
    expect(world.join(room, origin)).toBe(true)
    expect(world.join(room, finisher)).toBe(true)
    advanceTo(1)
    attack(origin, 1)
    advanceTo(16)
    const firstHp = room.snapshot().monsters[0].hp
    expect(firstHp).toBe(51)
    const { characterId, reconnectToken } = session(origin)
    if (status === 'transferring' || status === 'transferred') {
      expect(findOverlappingPortal(room.map, body(room, origin).position)?.id).toBe('p_to_village')
      expect(request(world, room, origin)).toBe(true)
      advanceTo(17)
      expect(origin.offer).toHaveBeenCalledOnce()
      if (status === 'transferred') {
        const candidate = peer()
        expect(claim(world, village, origin, candidate)).toBe(true)
        advanceTo(18)
        expect(village.player(characterId)).toBeDefined()
        expect(room.player(characterId)).toBeUndefined()
      }
    } else {
      world.leave(room, origin.connection, true)
      expect(room.player(characterId)).toBeDefined()
      if (status === 'reconnected') {
        const rebound = peer()
        expect(world.reconnect(room, rebound, reconnectToken)).toBe(true)
        expect(session(rebound).characterId).toBe(characterId)
      } else if (status === 'expired') {
        advanceTo(930)
        expect(room.player(characterId)).toBeUndefined()
        expect(world.reconnect(room, peer(), reconnectToken)).toBe(false)
      }
    }
    for (let seq = 1; seq <= 3; seq++) {
      attack(finisher, seq)
      advanceTo(room.snapshot().serverTick + 18)
    }
    await Promise.resolve()
    expect(rewardPort.commitReward).toHaveBeenCalledOnce()
    const [intent] = rewardPort.commitReward.mock.lastCall
    const otherId = session(finisher).characterId
    expect(intent.claim.mapInstanceId).toBe(room.mapInstanceId)
    expect(intent.groups).toMatchObject([
      {
        groupKey: 'party:shared',
        effectiveDamage: 71,
        eligibleCharacterIds: status === 'reconnected' ? [characterId, otherId].sort() : [otherId],
        contributions: expect.arrayContaining([
          {
            characterId,
            effectiveDamage: 20,
            lastDamageTick: 6,
            lockedGroup: { kind: 'party', partyId: 'shared', membershipToken: `tenure:${characterId}` },
          },
        ]),
      },
    ])
    expect(room.snapshot().monsters[0]).toMatchObject({ monsterId: intent.claim.monsterId, hp: 0 })
    expect(independent.snapshot().monsters[0].hp).toBe(71)
    await Promise.resolve()
    advanceTo(room.snapshot().serverTick + 1)
    if (status === 'transferring') expect(room.player(characterId)).toBeDefined()
    world.disposeRoom(room)
    world.disposeRoom(village)
    world.disposeRoom(independent)
    expect(room.snapshot().monsters).toEqual([])
    expect(rewardPort.releaseReceipt).toHaveBeenCalledExactlyOnceWith(intent.claim.deathId)
  }
)

test('settles an accepted reward after its last room is disposed without recreating the monster', async () => {
  const { world, room, advance, advanceTo, attack, rewardPort } = rewardHarness((memory) =>
    vi.fn(memory.commitReward).mockRejectedValueOnce(new Error('temporary failure'))
  )
  const commit = rewardPort.commitReward
  const killer = peer()
  expect(world.join(room, killer)).toBe(true)
  advanceTo(1)
  for (let seq = 1; seq <= 4; seq++) {
    attack(killer, seq)
    advanceTo(room.snapshot().serverTick + 18)
  }
  expect(room.snapshot().monsters[0].hp).toBe(0)
  world.disposeRoom(room)
  expect(room.snapshot().monsters).toEqual([])
  for (let index = 0; index < 5; index++) await Promise.resolve()
  expect(commit).toHaveBeenCalledOnce()
  expect(rewardPort.releaseReceipt).not.toHaveBeenCalled()
  advance()
  for (let index = 0; index < 5; index++) await Promise.resolve()
  expect(commit).toHaveBeenCalledTimes(2)
  expect(commit.mock.calls[0][0]).toBe(commit.mock.calls[1][0])
  advance()
  expect(rewardPort.releaseReceipt).toHaveBeenCalledOnce()
  expect(room.snapshot().monsters).toEqual([])
})

test('routes a stable actor through Village and M1 before either room steps, with a single private owner', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  const observer = peer()
  expect(world.join(m1, source)).toBe(true)
  expect(world.join(m1, observer)).toBe(true)
  expect(world.join(village, source)).toBe(false)
  const { characterId, connectionEpoch, reconnectToken } = session(source)
  expect(request(world, m1, source, 0)).toBe(true)
  advance()
  expect(source.failed).toHaveBeenLastCalledWith({ requestId: 0, code: 'PORTAL_UNAVAILABLE' })

  walkToPortal(h, m1, source)
  expect(request(world, m1, source)).toBe(true)
  expect(request(world, m1, source)).toBe(false)
  advance()
  expect(offer(source)).toMatchObject({ requestId: 1, mapId: 'village', mapEpoch: 1 })
  expect(body(m1, source)).toBeDefined()
  expect(village.player(characterId)).toBeUndefined()
  const next = peer()
  expect(claim(world, m1, source, next)).toBe(false)
  expect(claim(world, village, source, next, session(observer).reconnectToken)).toBe(false)
  expect(claim(world, village, source, next)).toBe(true)
  expect(claim(world, village, source, peer())).toBe(false)
  expect(next.joined).not.toHaveBeenCalled()
  expect(world.checkpoint(village, next.connection)).toBeUndefined()

  const vitals = { hp: 19, maxHp: 50, mp: 4, maxMp: 20 }
  const before = body(m1, source)
  const readPlayer = m1.player
  const player = vi.spyOn(m1, 'player').mockImplementation((id) => (id === characterId ? { ...before, vitals } : readPlayer(id)))
  const advanceM1 = m1.advance
  const advanceVillage = village.advance
  vi.spyOn(m1, 'advance').mockImplementation((...args) => {
    expect(m1.snapshot().players.some((player) => player.characterId === characterId)).toBe(false)
    expect(village.player(characterId)).toBeDefined()
    advanceM1(...args)
  })
  vi.spyOn(village, 'advance').mockImplementation((...args) => {
    expect(m1.snapshot().players.some((player) => player.characterId === characterId)).toBe(false)
    expect(village.player(characterId)).toBeDefined()
    advanceVillage(...args)
  })
  advance()
  player.mockRestore()
  m1.advance.mockRestore()
  village.advance.mockRestore()
  expect(m1.player(characterId)).toBeUndefined()
  expect(body(village, next)).toMatchObject({ vitals, lifeStartedTick: before.lifeStartedTick, position: { x: 1188, y: 656 } })
  expect(m1.snapshot().monsters).toHaveLength(10)
  expect(village.snapshot().monsters).toHaveLength(0)
  expect(session(next)).toMatchObject({ characterId, reconnectToken, mapEpoch: 1 })
  expect(session(next).connectionEpoch).not.toBe(connectionEpoch)
  expect(world.checkpoint(m1, source.connection)).toBeUndefined()
  expect(world.checkpoint(village, next.connection)).toMatchObject({ characterId, mapEpoch: 1, ackInputSeq: null })
  expect(world.checkpoint(m1, observer.connection).characterId).toBe(session(observer).characterId)
  expect(JSON.stringify(village.snapshot())).not.toContain(reconnectToken)
  expect(claim(world, village, source, peer())).toBe(false)
  world.leave(m1, source.connection)
  expect(request(world, village, next, 1, { mapEpoch: 0 })).toBe(false)
  expect(
    world.receive(village, next.connection, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch: session(next).connectionEpoch,
      mapEpoch: 0,
      seq: 1,
      moveX: -1,
      jumpPressed: false,
      attackPressed: false,
    })
  ).toBe(false)

  walkToPortal(h, village, next)
  expect(request(world, village, next)).toBe(true)
  advance()
  const returned = peer()
  expect(claim(world, m1, next, returned)).toBe(true)
  for (const [room, step] of [
    [m1, advanceM1],
    [village, advanceVillage],
  ]) {
    vi.spyOn(room, 'advance').mockImplementation((...args) => {
      expect(m1.player(characterId)).toBeDefined()
      expect(village.player(characterId)).toBeUndefined()
      step(...args)
    })
  }
  advance()
  expect(session(returned)).toMatchObject({ characterId, mapEpoch: 2 })
  expect(body(m1, returned)).toMatchObject({ vitals, position: { x: 308, y: 848 }, spawnProtected: true })
  expect(village.player(characterId)).toBeUndefined()
  expect(request(world, m1, returned, 1)).toBe(true)
  advance()
  expect(returned.offer).not.toHaveBeenCalled()
})

test('rejects invalid requests, enforces 20 seats under competition and rolls back an expired offer', () => {
  const h = harness()
  const { world, advance, setNow } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const first = peer()
  const second = peer()
  world.join(m1, first)
  world.join(m1, second)
  const residents = Array.from({ length: 19 }, peer)
  for (const resident of residents) expect(world.join(village, resident)).toBe(true)
  walkToPortal(h, m1, first, second)
  expect(request(world, m1, first, 0, { destination: 'village' })).toBe(false)
  expect(request(world, m1, first, 0, { mapEpoch: 99 })).toBe(false)
  expect(request(world, m1, first, 0, { objectId: 'p_to_m5' })).toBe(true)
  advance()
  expect(first.failed).toHaveBeenCalledWith({ requestId: 0, code: 'PORTAL_UNAVAILABLE' })
  expect(request(world, m1, first, 0)).toBe(false)
  expect(request(world, m1, first)).toBe(true)
  expect(request(world, m1, second)).toBe(true)
  advance()
  const frozen = body(m1, first).position
  expect(first.offer).toHaveBeenCalledOnce()
  expect(second.failed).toHaveBeenLastCalledWith({ requestId: 1, code: 'MAP_SEAT_UNAVAILABLE' })
  expect(village.snapshot().players).toHaveLength(19)
  expect(world.join(village, peer())).toBe(false)
  setNow(10_000)
  expect(claim(world, village, first, peer())).toBe(false)
  advance()
  expect(first.failed).toHaveBeenLastCalledWith({ requestId: 1, code: 'TRANSFER_EXPIRED' })
  expect(body(m1, first).position).toEqual(frozen)
  expect(village.hasCapacity()).toBe(true)
  expect(world.canAdmit()).toBe(false)
  expect(world.join(village, peer())).toBe(false)
  expect(world.checkpoint(m1, first.connection).mapEpoch).toBe(0)
})

test('rejects an overlapping Up request while airborne', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  world.createRoom('village')
  const source = peer()
  world.join(m1, source)
  walkToPortal(h, m1, source)
  const { connectionEpoch, mapEpoch } = session(source)
  expect(
    world.receive(m1, source.connection, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      seq: 45,
      moveX: 0,
      jumpPressed: true,
      attackPressed: false,
    })
  ).toBe(true)
  advance()
  expect(body(m1, source).physics.grounded).toBe(false)
  expect(findOverlappingPortal(m1.map, body(m1, source).position)?.id).toBe('p_to_village')
  expect(request(world, m1, source)).toBe(true)
  advance()
  expect(source.failed).toHaveBeenCalledExactlyOnceWith({ requestId: 1, code: 'PORTAL_UNAVAILABLE' })
  expect(source.offer).not.toHaveBeenCalled()
})

test('restores the source after destination creation fails or a claimed destination is lost before the commit', async () => {
  const createDestination = vi.fn().mockRejectedValue(new Error('no room'))
  const h = harness(createDestination)
  const { world, advance } = h
  const m1 = world.createRoom()
  const source = peer()
  world.join(m1, source)
  walkToPortal(h, m1, source)
  expect(request(world, m1, source)).toBe(true)
  advance()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  advance()
  expect(createDestination).toHaveBeenCalledExactlyOnceWith('village')
  expect(source.failed).toHaveBeenLastCalledWith({ requestId: 1, code: 'TRANSFER_FAILED' })
  expect(body(m1, source)).toBeDefined()

  const village = world.createRoom('village')
  expect(request(world, m1, source, 2)).toBe(true)
  advance()
  const candidate = peer()
  expect(claim(world, village, source, candidate)).toBe(true)
  const prepareArrival = vi.spyOn(village, 'prepareArrival').mockImplementationOnce(() => {
    throw new Error('arrival preparation failed')
  })
  expect(advance).not.toThrow()
  prepareArrival.mockRestore()
  expect(candidate.joined).not.toHaveBeenCalled()
  expect(candidate.close).toHaveBeenCalledOnce()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(village.player(session(source).characterId)).toBeUndefined()
  expect(source.failed).toHaveBeenLastCalledWith({ requestId: 2, code: 'TRANSFER_FAILED' })
  expect(body(m1, source)).toBeDefined()
  expect(m1.snapshot().serverTick).toBe(village.snapshot().serverTick)
  expect(world.reconnect(m1, peer(), session(source).reconnectToken)).toBe(false)
  expect(claim(world, village, source, peer())).toBe(false)
  world.leave(village, candidate.connection)
  expect(world.checkpoint(m1, source.connection)).toBeDefined()
})

test('keeps the committed body recoverable when transport callbacks throw', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  expect(world.join(m1, source)).toBe(true)
  walkToPortal(h, m1, source)
  const { characterId, reconnectToken } = session(source)
  expect(request(world, m1, source)).toBe(true)
  advance()
  const candidate = peer()
  expect(claim(world, village, source, candidate)).toBe(true)
  candidate.joined.mockImplementationOnce(() => {
    throw new Error('destination notification failed')
  })
  source.close.mockImplementationOnce(() => {
    throw new Error('source close failed')
  })
  expect(advance).not.toThrow()
  expect(candidate.close).toHaveBeenCalledOnce()
  expect(source.close).toHaveBeenCalledOnce()
  expect(m1.player(characterId)).toBeUndefined()
  expect(village.player(characterId)).toBeDefined()
  expect(m1.snapshot().serverTick).toBe(village.snapshot().serverTick)
  expect(village.hasRetainedSeats()).toBe(true)
  expect(world.checkpoint(village, candidate.connection)).toBeUndefined()
  expect(world.checkpoint(m1, source.connection)).toBeUndefined()
  expect(claim(world, village, source, peer())).toBe(false)
  expect(world.reconnect(m1, peer(), reconnectToken)).toBe(false)

  const recovered = peer()
  expect(world.reconnect(village, recovered, reconnectToken)).toBe(true)
  expect(session(recovered)).toMatchObject({ characterId, mapEpoch: 1 })
  expect(session(recovered).reconnectToken).not.toBe(reconnectToken)
  world.leave(m1, source.connection)
  world.leave(village, candidate.connection)
  expect(world.checkpoint(village, recovered.connection)).toMatchObject({ characterId, mapEpoch: 1 })
})

test('disposal clears destination claims and removes source grace seats and credentials', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  expect(world.join(m1, source)).toBe(true)
  walkToPortal(h, m1, source)
  expect(request(world, m1, source)).toBe(true)
  advance()
  const candidate = peer()
  expect(claim(world, village, source, candidate)).toBe(true)
  world.disposeRoom(village)
  advance()
  expect(candidate.close).toHaveBeenCalledOnce()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(source.failed).toHaveBeenLastCalledWith({ requestId: 1, code: 'TRANSFER_FAILED' })
  expect(world.checkpoint(m1, source.connection)).toBeDefined()
  const { characterId, reconnectToken } = session(source)
  world.leave(m1, source.connection, true)
  world.disposeRoom(m1)
  expect(m1.hasRetainedSeats()).toBe(false)
  expect(m1.player(characterId)).toBeUndefined()
  const replacement = world.createRoom()
  expect(world.reconnect(m1, peer(), reconnectToken)).toBe(false)
  expect(world.reconnect(replacement, peer(), reconnectToken)).toBe(false)
  expect(claim(world, world.createRoom('village'), source, candidate)).toBe(false)
  expect(world.join(replacement, candidate)).toBe(true)
})

test('recovers pre-commit at the source and post-commit at the destination while fencing input and old callbacks', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const original = peer()
  world.join(m1, original)
  walkToPortal(h, m1, original)
  const { characterId, reconnectToken, connectionEpoch } = session(original)
  const frame = (epoch, mapEpoch, seq = 45) => ({
    protocolVersion: PROTOCOL_VERSION,
    connectionEpoch: epoch,
    mapEpoch,
    seq,
    moveX: 1,
    jumpPressed: true,
    attackPressed: false,
  })
  expect(world.receive(m1, original.connection, frame(connectionEpoch, 0))).toBe(true)
  expect(request(world, m1, original)).toBe(true)
  advance()
  const uncommitted = peer()
  expect(claim(world, village, original, uncommitted)).toBe(true)
  world.leave(m1, original.connection, true)
  expect(uncommitted.close).toHaveBeenCalledOnce()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(m1.hasRetainedSeats()).toBe(true)
  expect(world.checkpoint(m1, original.connection)).toBeUndefined()
  expect(world.receive(m1, original.connection, frame(connectionEpoch, 0))).toBe(false)
  expect(world.reconnect(village, peer(), reconnectToken)).toBe(false)
  expect(world.reconnect(m1, peer(), 'wrong')).toBe(false)
  advance()
  expect(m1.player(characterId)).toMatchObject({ physics: { grounded: true }, movement: { moveX: 0, jumpBufferTicksRemaining: 0 } })

  const recovered = peer()
  expect(world.reconnect(m1, recovered, reconnectToken)).toBe(true)
  expect(world.reconnect(m1, peer(), reconnectToken)).toBe(false)
  expect(session(recovered)).toMatchObject({ characterId, mapEpoch: 0 })
  expect(session(recovered).connectionEpoch).not.toBe(connectionEpoch)
  expect(session(recovered).reconnectToken).not.toBe(reconnectToken)
  expect(world.receive(m1, recovered.connection, frame(connectionEpoch, 0))).toBe(false)
  world.leave(m1, original.connection)
  world.leave(m1, original.connection, true)
  world.leave(village, uncommitted.connection, true)
  expect(world.checkpoint(m1, recovered.connection)).toMatchObject({ ackInputSeq: null })

  expect(request(world, m1, recovered)).toBe(true)
  advance()
  const destination = peer()
  expect(claim(world, village, recovered, destination)).toBe(true)
  advance()
  world.leave(village, destination.connection, true)
  world.leave(m1, recovered.connection)
  expect(world.reconnect(m1, peer(), session(recovered).reconnectToken)).toBe(false)
  expect(world.reconnect(village, peer(), reconnectToken)).toBe(false)
  const landed = peer()
  expect(world.reconnect(village, landed, session(recovered).reconnectToken)).toBe(true)
  expect(session(landed)).toMatchObject({ characterId, mapEpoch: 1 })
  expect(body(village, landed).position).toEqual({ x: 1188, y: 656 })
  expect(m1.player(characterId)).toBeUndefined()
  expect(world.receive(village, landed.connection, frame(session(destination).connectionEpoch, 1, 1))).toBe(false)
  expect(world.receive(village, landed.connection, frame(session(landed).connectionEpoch, 1, 1))).toBe(true)
  world.leave(village, destination.connection, true)
  expect(world.checkpoint(village, landed.connection)).toMatchObject({ characterId, mapEpoch: 1 })
})

test('expires grace seats at 30 seconds and keeps an unconfirmed token only for lost join acknowledgement recovery', () => {
  const h = harness()
  const { world, advance, setNow } = h
  const room = world.createRoom()
  const original = peer()
  world.join(room, original)
  for (let index = 0; index < 19; index++) expect(world.join(room, peer())).toBe(true)
  advance()
  const { characterId, connectionEpoch, reconnectToken, mapEpoch } = session(original)
  const atSpawn = room.player(characterId).position
  expect(
    world.receive(room, original.connection, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      seq: 1,
      moveX: 1,
      jumpPressed: true,
      attackPressed: false,
    })
  ).toBe(true)
  world.leave(room, original.connection, true)
  advance()
  expect(room.player(characterId)).toMatchObject({
    position: atSpawn,
    physics: { grounded: true },
    movement: { moveX: 0, lastProcessedInputSeq: null },
  })
  expect(world.join(room, peer())).toBe(false)
  const intermediate = peer()
  setNow(29_999 - 34)
  expect(world.reconnect(room, intermediate, reconnectToken)).toBe(true)
  world.leave(room, intermediate.connection, true)
  const restored = peer()
  expect(world.reconnect(room, restored, reconnectToken)).toBe(true)
  expect(body(room, restored).position).toEqual(atSpawn)
  expect(world.reconnect(room, peer(), session(intermediate).reconnectToken)).toBe(false)
  world.leave(room, restored.connection, true)
  setNow(30_000)
  expect(world.reconnect(room, peer(), session(restored).reconnectToken)).toBe(false)
  expect(world.reconnect(room, peer(), reconnectToken)).toBe(false)
  advance()
  expect(room.player(characterId)).toBeUndefined()
  expect(room.hasCapacity()).toBe(true)
  expect(room.hasRetainedSeats()).toBe(false)
})

test('cancels a claimed ticket on destination drop and ignores later cancellation or timeout callbacks', () => {
  const h = harness()
  const { world, advance } = h
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  world.join(m1, source)
  walkToPortal(h, m1, source)
  request(world, m1, source)
  advance()
  const candidate = peer()
  expect(claim(world, village, source, candidate)).toBe(true)
  world.cancelTransfer(m1, candidate.connection, offer(source).ticket)
  world.cancelTransfer(m1, source.connection, 'wrong')
  world.leave(village, candidate.connection, true)
  world.leave(village, candidate.connection)
  advance()
  expect(source.failed).toHaveBeenCalledExactlyOnceWith({ requestId: 1, code: 'TRANSFER_FAILED' })
  expect(candidate.joined).not.toHaveBeenCalled()
  expect(village.hasRetainedSeats()).toBe(false)
  expect(body(m1, source)).toBeDefined()
  const stale = offer(source).ticket
  request(world, m1, source, 2)
  advance()
  world.cancelTransfer(m1, source.connection, stale)
  expect(claim(world, village, source, peer())).toBe(true)
  advance()
  expect(village.player(session(source).characterId)).toBeDefined()
})

test('retains a disconnected Death body until the recovered owner can take the Village respawn handoff', () => {
  const { world, advance } = harness()
  const m1 = world.createRoom()
  const village = world.createRoom('village')
  const source = peer()
  world.join(m1, source)
  const { characterId, connectionEpoch, mapEpoch, reconnectToken } = session(source)
  advance()
  for (let seq = 1; seq <= 180 && body(m1, source).action.kind !== 'death'; seq++) {
    world.receive(m1, source.connection, {
      protocolVersion: PROTOCOL_VERSION,
      connectionEpoch,
      mapEpoch,
      seq,
      moveX: 1,
      jumpPressed: false,
      attackPressed: false,
    })
    advance()
  }
  const dead = body(m1, source)
  expect(dead.action.kind).toBe('death')
  world.leave(m1, source.connection, true)
  for (let tick = 0; tick < 95; tick++) advance()
  expect(m1.player(characterId)).toMatchObject({ action: dead.action, position: dead.position })
  expect(village.player(characterId)).toBeUndefined()
  expect(village.hasRetainedSeats()).toBe(false)
  const rebound = peer()
  expect(world.reconnect(m1, rebound, reconnectToken)).toBe(true)
  advance()
  expect(offer(rebound)).toMatchObject({ requestId: null, mapId: 'village', mapEpoch: 1 })
  const destination = peer()
  expect(claim(world, village, rebound, destination)).toBe(true)
  advance()
  expect(session(destination)).toMatchObject({ characterId, mapEpoch: 1 })
  expect(m1.player(characterId)).toBeUndefined()
  const respawned = body(village, destination)
  expect(respawned).toMatchObject({ action: { kind: 'none' }, position: { x: 628, y: 656 } })
  expect(respawned.vitals.hp).toBe(respawned.vitals.maxHp)
  expect(respawned.lifeStartedTick).toBeGreaterThan(dead.lifeStartedTick)
})
