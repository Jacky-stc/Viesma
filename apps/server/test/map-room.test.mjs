import { matchMaker, Server } from '@colyseus/core'
import { Client } from '@colyseus/sdk'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { loadGrayboxGameData, serializeMapManifest } from '@viesma/game-data'
import { MapRoomSchema, readPublicMonsters, readPublicPlayers } from '@viesma/network-colyseus'
import {
  inputFrameMessage,
  mapRoomJoinedMessage,
  mapRoomName,
  movementCheckpointMessage,
  parseMovementCheckpoint,
  PROTOCOL_VERSION,
} from '@viesma/protocol'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createMapRoomClass } from '../src/adapters/map-room.ts'
import { createWorldCoordinator } from '../src/runtime/world-coordinator.ts'

const data = loadGrayboxGameData()
const version = {
  protocolVersion: PROTOCOL_VERSION,
  balanceVersion: data.balanceVersion,
  mapContentHash: createHash('sha256').update(serializeMapManifest(data)).digest('hex'),
}
let now = 0
let nextId = 0
let wake
const stop = vi.fn(() => {
  wake = undefined
})
const world = createWorldCoordinator(data, version.mapContentHash, {
  clock: { nowMilliseconds: () => now },
  nextId: () => `dev-${++nextId}`,
  onBacklog: vi.fn(),
  schedule(callback) {
    wake = callback
    return stop
  },
})
const createRoom = vi.spyOn(world, 'createRoom')
const transport = new WebSocketTransport()
const server = new Server({ transport, gracefullyShutdown: false, greet: false })
let client

beforeAll(async () => {
  server.define(mapRoomName, createMapRoomClass(world, version, 1))
  await server.listen(0, '127.0.0.1')
  client = new Client(`http://127.0.0.1:${transport.server.address().port}`)
})

afterAll(async () => {
  await server.gracefullyShutdown(false)
})

function advance() {
  now += 100
  wake()
}

function observe(room) {
  const connection = { room, binding: undefined, checkpoints: [] }
  room.reconnection.enabled = false
  room.onMessage(mapRoomJoinedMessage, ({ reconnectToken, ...binding }) => {
    connection.binding = binding
    connection.reconnectToken = reconnectToken
  })
  room.onMessage(movementCheckpointMessage, (payload) => {
    connection.checkpoints.push({ checkpoint: parseMovementCheckpoint(payload), publicTick: room.state.serverTick })
  })
  return connection
}

function send(connection, seq, fields = {}) {
  const { binding, room } = connection
  room.send(inputFrameMessage, {
    protocolVersion: PROTOCOL_VERSION,
    connectionEpoch: binding.connectionEpoch,
    mapEpoch: binding.mapEpoch,
    seq,
    moveX: 1,
    jumpPressed: true,
    attackPressed: false,
    ...fields,
  })
}

test('shares M1 through the actual room lifecycle and isolates another room', async () => {
  const first = observe(await client.joinOrCreate(mapRoomName, version, MapRoomSchema))
  const second = observe(await client.joinOrCreate(mapRoomName, version, MapRoomSchema))
  const other = observe(await client.create(mapRoomName, version, MapRoomSchema))
  const { room } = first
  expect(second.room.roomId).toBe(room.roomId)
  expect(other.room.roomId).not.toBe(room.roomId)
  for (const connection of [first, second, other]) {
    await expect.poll(() => connection.room.state.serverTick).toBe(0)
  }
  advance()
  await expect.poll(() => room.state.players.size).toBe(2)
  await expect.poll(() => other.room.state.players.size).toBe(1)
  await expect.poll(() => second.room.state.players.size).toBe(2)
  expect(room.state.mapId).toBe('m1')
  expect(room.state.mapContentHash).toBe(version.mapContentHash)
  expect(room.state.serverTick).toBe(3)
  expect(room.state.mapInstanceId).not.toBe(other.room.state.mapInstanceId)
  const players = () => readPublicPlayers(room.state)
  expect(players()).toEqual(readPublicPlayers(second.room.state))
  const spawn = players().find(({ characterId }) => characterId === first.binding.characterId)
  expect(spawn).toBeDefined()
  expect(JSON.stringify(room.state)).not.toContain(first.binding.connectionEpoch)
  expect(JSON.stringify(room.state)).not.toContain(first.reconnectToken)
  expect(other.room.state.players.has(first.binding.characterId)).toBe(false)
  for (const connection of [first, second, other]) {
    await expect
      .poll(() => connection.checkpoints)
      .toEqual([
        {
          checkpoint: expect.objectContaining({
            ...connection.binding,
            mapInstanceId: connection.room.state.mapInstanceId,
            serverTick: 3,
            ackInputSeq: null,
          }),
          publicTick: 3,
        },
      ])
  }

  await expect(client.joinById(room.roomId, { ...version, protocolVersion: 999 }, MapRoomSchema)).rejects.toThrow(
    'PROTOCOL_VERSION_MISMATCH'
  )
  await expect(client.joinById(room.roomId, { ...version, protocolVersion: 3 }, MapRoomSchema)).rejects.toThrow('PROTOCOL_VERSION_MISMATCH')
  await expect(client.joinById(room.roomId, { ...version, balanceVersion: 'old' }, MapRoomSchema)).rejects.toThrow(
    'BALANCE_VERSION_MISMATCH'
  )
  await expect(client.joinById(room.roomId, { ...version, mapContentHash: 'old' }, MapRoomSchema)).rejects.toThrow(
    'MAP_CONTENT_HASH_MISMATCH'
  )

  const serverRoom = matchMaker.getLocalRoomById(room.roomId)
  let received = 0
  serverRoom.clients.getById(first.room.sessionId).ref.on('message', () => {
    received++
  })
  send(first, 10, { x: 999999, hp: 0 })
  send(first, 11, { characterId: second.binding.characterId })
  send(first, 12, { connectionEpoch: second.binding.connectionEpoch })
  await expect.poll(() => received).toBe(3)
  advance()
  await expect.poll(() => room.state.serverTick).toBe(6)
  expect(players().find(({ characterId }) => characterId === first.binding.characterId)).toEqual(spawn)

  send(first, 1)
  send(first, 1)
  send(first, 0, { moveX: -1, jumpPressed: false })
  await expect.poll(() => received).toBe(6)
  advance()
  await expect.poll(() => room.state.serverTick).toBe(9)
  await expect.poll(() => second.room.state.serverTick).toBe(9)
  const moved = players().find(({ characterId }) => characterId === first.binding.characterId)
  expect(moved.x).toBeGreaterThan(spawn.x)
  expect(moved.y).toBeLessThan(spawn.y)
  expect(moved.hp).toBe(spawn.hp)
  expect(players()).toEqual(readPublicPlayers(second.room.state))
  expect(other.room.state.players.get(other.binding.characterId)).toMatchObject({ x: spawn.x, y: spawn.y })
  await expect
    .poll(() => first.checkpoints.at(-1))
    .toMatchObject({
      publicTick: 9,
      checkpoint: {
        serverTick: 9,
        ackInputSeq: 1,
        controller: {
          position: { x: moved.x, y: moved.y },
          physics: { grounded: false },
          movement: { lastProcessedInputSeq: 1, jumpBufferTicksRemaining: 0, coyoteTicksRemaining: 0 },
        },
      },
    })
  await expect
    .poll(() => second.checkpoints.map(({ checkpoint }) => checkpoint.characterId))
    .toEqual(Array(3).fill(second.binding.characterId))

  // 非正常斷線撤銷輸入並保留 body，新的 transport 座位可在保留期內重新綁定。
  const firstId = first.binding.characterId
  const severed = serverRoom.clients.getById(first.room.sessionId)
  severed.ref.terminate()
  await expect.poll(() => serverRoom.clients.length).toBe(1)
  advance()
  await expect.poll(() => second.room.state.serverTick).toBe(12)
  expect(second.room.state.players.has(firstId)).toBe(true)
  const recovered = observe(await client.joinById(room.roomId, { ...version, reconnectToken: first.reconnectToken }, MapRoomSchema))
  await expect.poll(() => recovered.binding?.characterId).toBe(firstId)
  expect(recovered.binding.connectionEpoch).not.toBe(first.binding.connectionEpoch)
  expect(recovered.reconnectToken).not.toBe(first.reconnectToken)
  await expect(client.joinById(room.roomId, { ...version, reconnectToken: first.reconnectToken }, MapRoomSchema)).rejects.toThrow(
    'MAP_ADMISSION_INVALID'
  )
  await Promise.all([second.room.leave(), recovered.room.leave()])
  await expect.poll(() => matchMaker.getLocalRoomById(room.roomId)).toBeUndefined()
  expect(wake).toBeTypeOf('function')
  advance()
  await expect.poll(() => other.room.state.serverTick).toBe(15)
  await other.room.leave()
  await expect.poll(() => wake).toBeUndefined()
  expect(stop).toHaveBeenCalledOnce()
})

test('keeps the 21st concurrent seat out and releases expired reservations', async () => {
  const { room } = observe(await client.create(mapRoomName, version, MapRoomSchema))
  const reserved = await Promise.allSettled(Array.from({ length: 20 }, () => matchMaker.joinById(room.roomId, version)))
  const seats = reserved.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  expect(seats).toHaveLength(19)
  expect(reserved.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  await expect(matchMaker.joinById(room.roomId, version)).rejects.toThrow()

  const claims = await Promise.allSettled([
    client.consumeSeatReservation(seats[0], MapRoomSchema).then(observe),
    client.consumeSeatReservation(seats[0], MapRoomSchema).then(observe),
  ])
  const entered = claims.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  expect(entered).toHaveLength(1)
  advance()
  await expect.poll(() => room.state.players.size).toBe(2)
  await expect.poll(async () => (await matchMaker.getRoomById(room.roomId)).clients, { timeout: 4000 }).toBe(2)
  await expect(client.consumeSeatReservation(seats[1], MapRoomSchema)).rejects.toThrow()
  const replacement = observe(await client.joinById(room.roomId, version, MapRoomSchema))
  await Promise.all([room.leave(), entered[0].room.leave(), replacement.room.leave()])
  await expect.poll(() => matchMaker.getLocalRoomById(room.roomId)).toBeUndefined()
})

test('input flooding over the transport does not move a player faster than three frames per patch', async () => {
  const paced = observe(await client.create(mapRoomName, version, MapRoomSchema))
  const flood = observe(await client.joinById(paced.room.roomId, version, MapRoomSchema))
  try {
    advance()
    await expect.poll(() => paced.room.state.players.size).toBe(2)
    await expect.poll(() => flood.room.state.players.size).toBe(2)
    const position = ({ binding }) => paced.room.state.players.get(binding.characterId).x
    const start = position(paced)
    const serverRoom = matchMaker.getLocalRoomById(paced.room.roomId)
    let arrivals = 0
    for (const { room } of [paced, flood]) {
      serverRoom.clients.getById(room.sessionId).ref.on('message', () => arrivals++)
    }
    for (let batch = 0; batch < 5; batch++) {
      for (let index = 1; index <= 3; index++) send(paced, batch * 3 + index, { jumpPressed: false })
      for (let index = 1; index <= 12; index++) send(flood, batch * 12 + index, { jumpPressed: false })
      await expect.poll(() => arrivals).toBe((batch + 1) * 15)
      const previousTick = paced.room.state.serverTick
      advance()
      await expect.poll(() => paced.room.state.serverTick).toBe(previousTick + 3)
      expect(position(flood)).toBe(position(paced))
    }
    expect(position(paced)).toBeGreaterThan(start)
    for (const connection of [paced, flood]) {
      expect(connection.checkpoints.length).toBeGreaterThan(0)
      expect(connection.checkpoints.every(({ checkpoint }) => checkpoint.characterId === connection.binding.characterId)).toBe(true)
    }
  } finally {
    await Promise.all([paced.room.leave(), flood.room.leave()])
    await expect.poll(() => wake).toBeUndefined()
  }
})

test('publishes monster identity, movement and HP to both sockets and gives late joins a fresh full projection', async () => {
  const first = observe(await client.create(mapRoomName, version, MapRoomSchema))
  const second = observe(await client.joinById(first.room.roomId, version, MapRoomSchema))
  const other = observe(await client.create(mapRoomName, version, MapRoomSchema))
  advance()
  await expect.poll(() => first.room.state.players.size).toBe(2)
  await expect.poll(() => second.room.state.serverTick).toBe(first.room.state.serverTick)
  const read = ({ room }) => readPublicMonsters(room.state)
  const firstSnapshot = read(first)
  const one = firstSnapshot.find(({ x, y }) => x === 471 && y === 896)
  const find = (connection, id = one.monsterId) => read(connection).find(({ monsterId }) => monsterId === id)
  expect(one).toMatchObject({ x: 471, y: 896, hp: 71, state: 'patrol' })
  expect(firstSnapshot).toHaveLength(10)
  expect(read(second)).toEqual(firstSnapshot)
  await expect.poll(() => read(other).find(({ x, y }) => x === 471 && y === 896)).toBeDefined()
  const separate = read(other).find(({ x, y }) => x === 471 && y === 896)
  expect(read(other).every(({ monsterId }) => firstSnapshot.every((monster) => monster.monsterId !== monsterId))).toBe(true)
  const otherRuntime = createRoom.mock.results.find(({ value }) => value.mapInstanceId === other.room.state.mapInstanceId).value

  const serverRoom = matchMaker.getLocalRoomById(first.room.roomId)
  let received = 0
  serverRoom.clients.getById(first.room.sessionId).ref.on('message', (data) => {
    if (data.includes('InputFrame')) received++
  })
  send(first, 0, { monsterId: one.monsterId, hp: 0, x: 0 })
  const forged = observe(await client.joinById(first.room.roomId, version, MapRoomSchema))
  serverRoom.clients.getById(forged.room.sessionId).ref.on('message', (data) => {
    if (data.includes('MonsterFixtureEvent')) received++
  })
  forged.room.send('MonsterFixtureEvent', { monsterId: one.monsterId, kind: 'remove' })
  await expect.poll(() => received).toBe(2)
  await forged.room.leave()
  await expect.poll(() => serverRoom.clients.length).toBe(2)
  advance()
  await expect.poll(() => find(second)?.x).toBe(477)
  expect(find(second)).toMatchObject({ monsterId: one.monsterId, hp: 71 })

  expect(find(other, separate.monsterId)).toMatchObject({ ...separate, x: expect.any(Number) })
  await second.room.leave()
  advance()
  await expect.poll(() => first.room.state.players.size).toBe(1)
  expect(find(first)).toEqual({ ...one, x: 483 })
  const rejoined = observe(await client.joinById(first.room.roomId, version, MapRoomSchema))
  await expect.poll(() => read(rejoined)).toEqual(read(first))

  expect(read(rejoined)).toHaveLength(10)
  expect(find(other, separate.monsterId)).toMatchObject({ monsterId: separate.monsterId, hp: 71 })
  await Promise.all([first.room.leave(), rejoined.room.leave(), other.room.leave()])
  await expect.poll(() => matchMaker.getLocalRoomById(other.room.roomId)).toBeUndefined()
  expect(otherRuntime.snapshot().monsters).toEqual([])
})
