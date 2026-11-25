import { currencyLimit } from '@viesma/domain'
import { loadGrayboxGameData } from '@viesma/game-data'
import { changeCurrency } from '@viesma/simulation'
import { log } from 'node:console'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { clearInterval, setInterval } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'
import pg from 'pg'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createCharacterCoordinator, makeCharacterRequest } from '../../apps/server/src/runtime/character-coordinator.ts'
import { createMemoryCharacterRepository } from '../../apps/server/src/runtime/memory-character-repository.ts'
import { startCommitResponseProxy } from './commit-proxy.mjs'
import { createPgSpikeRepository, currencyRequest, equipmentRequest, grantRequest } from './repository.mjs'
import { createTickHarness } from './tick-harness.mjs'

const database = process.env.VIESMA_SPIKE_DB_ID
const password = process.env.VIESMA_SPIKE_DB_PASSWORD
const port = Number(process.env.VIESMA_SPIKE_DB_PORT)
if (
  !/^viesma_pg_[a-f0-9]{16}$/.test(database) ||
  !/^[a-f0-9]{48}$/.test(password) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Use the disposable PostgreSQL launcher')

const data = loadGrayboxGameData()
const ddl = await readFile(new URL('./schema.sql', import.meta.url), 'utf8')
const connections = []
let schemaNumber = 0
let main

async function connect(targetPort = port) {
  const client = new pg.Client({
    host: '127.0.0.1',
    database,
    user: database,
    password,
    port: targetPort,
    ssl: false,
    connectionTimeoutMillis: 3000,
    query_timeout: 8000,
  })
  await client.connect()
  connections.push(client)
  return client
}

async function session(targetPort) {
  const client = await connect(targetPort)
  await client.query(`SET search_path TO spike_${schemaNumber}`)
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid')
  return { client, pid: rows[0].pid, repository: createPgSpikeRepository(client, data.items) }
}

beforeEach(async () => {
  schemaNumber += 1
  const client = await connect()
  await client.query(`CREATE SCHEMA spike_${schemaNumber}`)
  await client.query(`SET search_path TO spike_${schemaNumber}`)
  await client.query(ddl)
  main = await session()
})

afterEach(async () => {
  await Promise.all(connections.splice(0).map((client) => client.end()))
})

function barrier() {
  const entered = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  return {
    entered: entered.promise,
    async hold() {
      entered.resolve()
      await proceed.promise
    },
    release: proceed.resolve,
  }
}

async function expectBlocked(observer, waiter, holder) {
  await vi.waitFor(
    async () => {
      const { rows } = await observer.query('SELECT pg_blocking_pids($1) AS blockers', [waiter])
      expect(rows[0].blockers).toContain(holder)
    },
    { timeout: 1000, interval: 10 }
  )
}

const weapon = (id) => ({ itemDefinitionId: 'training_sword', quantity: 1, itemInstanceId: id })
const potion = (quantity, extra = {}) => ({ itemDefinitionId: 'hp_potion', quantity, ...extra })
const command = (id, version, operation, available) =>
  equipmentRequest(makeCharacterRequest('spike-play-lease', id, version, operation), available)
const unequip = (id, version, owner = 'alice') =>
  command(id, version, { kind: 'unequip', slot: 'weapon', itemInstanceId: `starter:${owner}` })
const outcome = (result) => result.receipt?.code ?? (result.kind === 'conflict' ? 'REQUEST_CONFLICT' : result.kind)

test('starts on the pinned PostgreSQL version and serializes competing starter creation', async () => {
  const { rows } = await main.client.query("SELECT version(), current_setting('transaction_isolation') AS isolation")
  expect(rows[0]).toMatchObject({ version: expect.stringMatching(/^PostgreSQL 18\.7\b/), isolation: 'read committed' })
  log(rows[0])
  const contender = await session()
  const observer = await session()
  const staged = barrier()
  const first = main.repository.initialize('alice', { afterWrite: staged.hold })
  await staged.entered
  const second = contender.repository.initialize('alice')
  try {
    await expectBlocked(observer.client, contender.pid, main.pid)
    expect(await observer.repository.read('alice')).toBeUndefined()
  } finally {
    staged.release()
  }
  const starter = await first
  expect(await second).toEqual(starter)
  expect(starter.version).toBe(0)
  expect(starter.inventory.bag.slice(0, 3).map((item) => item?.quantity)).toEqual([5, 3, undefined])
  expect(starter.inventory.equipment.weapon.itemInstanceId).toBe('starter:alice')
  expect((await observer.client.query('SELECT * FROM items')).rowCount).toBe(3)
})

test('forces same-character version competition while another character commits independently', async () => {
  await main.repository.initialize('alice')
  await main.repository.initialize('bob')
  const contender = await session()
  const observer = await session()
  const staged = barrier()
  const first = main.repository.execute('alice', unequip(1, 0), { beforeCommit: staged.hold })
  await staged.entered
  const second = contender.repository.execute('alice', unequip(2, 0))
  try {
    await expectBlocked(observer.client, contender.pid, main.pid)
    expect(await observer.repository.read('alice')).toMatchObject({ version: 0 })
    expect(outcome(await observer.repository.execute('bob', unequip(1, 0, 'bob')))).toBe('CONFIRMED')
  } finally {
    staged.release()
  }
  expect(await first).toMatchObject({ receipt: { version: 1, code: 'CONFIRMED', changed: true } })
  expect(await second).toMatchObject({ receipt: { version: 1, code: 'STALE_VERSION', changed: false } })
  expect(await observer.repository.read('alice')).toMatchObject({ version: 1, inventory: { equipment: { weapon: null } } })
  expect(await contender.repository.execute('alice', unequip(2, 0))).toMatchObject({ kind: 'replayed', receipt: { code: 'STALE_VERSION' } })
})

test('serializes server grants without lost updates or duplicate request effects', async () => {
  await main.repository.initialize('alice')
  const contender = await session()
  const observer = await session()
  const staged = barrier()
  const request = currencyRequest('grant-a', 5)
  const original = main.repository.execute('alice', request, { beforeCommit: staged.hold })
  await staged.entered
  const duplicate = contender.repository.execute('alice', request)
  try {
    await expectBlocked(observer.client, contender.pid, main.pid)
    expect(await observer.repository.findReceipt('alice', request.key)).toBeUndefined()
  } finally {
    staged.release()
  }
  const { receipt } = await original
  expect(await duplicate).toEqual({ kind: 'replayed', receipt })

  const locked = barrier()
  const second = main.repository.execute('alice', currencyRequest('grant-b', 8), { afterLock: locked.hold })
  await locked.entered
  const third = contender.repository.execute('alice', currencyRequest('grant-c', 13))
  try {
    await expectBlocked(observer.client, contender.pid, main.pid)
  } finally {
    locked.release()
  }
  expect(await second).toMatchObject({ receipt: { version: 2, changed: true } })
  expect(await third).toMatchObject({ receipt: { version: 3, changed: true } })
  expect(await observer.repository.execute('alice', currencyRequest('grant-a', 999))).toEqual({ kind: 'conflict' })
  expect(await observer.repository.read('alice')).toMatchObject({ version: 3, inventory: { currency: 26 } })
})

test('matches the memory coordinator for packing, full-bag swap, replay and invalid inventory', async () => {
  const memory = createMemoryCharacterRepository(data.items)
  const coordinator = createCharacterCoordinator(data, () => {}, memory)
  const pgRepo = main.repository
  for (const characterId of ['alice', 'bob']) {
    const { version, inventory } = coordinator.open(characterId)
    expect(await pgRepo.initialize(characterId)).toEqual({ version, inventory })
  }

  async function compare(characterId, request, memoryCode, expected) {
    expect(memoryCode).toBe(expected)
    expect(outcome(await pgRepo.execute(characterId, request))).toBe(expected)
    expect(await pgRepo.findReceipt(characterId, request.key)).toEqual(memory.findReceipt(characterId, request.key))
    const { inventory, version } = coordinator.read(characterId)
    expect(await pgRepo.read(characterId)).toEqual({ inventory, version })
    return version
  }

  const add = (characterId, id, item, expected = 'CONFIRMED') =>
    compare(characterId, grantRequest(id, item), coordinator.insert(characterId, id, item), expected)
  const equip = (characterId, request, expected = 'CONFIRMED') =>
    compare(characterId, request, coordinator.execute(characterId, request, request.available), expected)

  await add('alice', 'multistack', potion(199))
  expect((await pgRepo.read('alice')).inventory.bag.slice(0, 4).map((item) => item.quantity)).toEqual([99, 3, 99, 6])
  await add('alice', 'metadata', potion(1, { metadata: { region: 'east', fragile: true } }))
  await add('alice', 'metadata', potion(1, { metadata: { fragile: true, region: 'east' } }))
  await add('alice', 'metadata', potion(2, { metadata: { fragile: true, region: 'east' } }), 'REQUEST_CONFLICT')
  await add('alice', 'fill', { itemDefinitionId: 'mp_potion', quantity: 18 * 99 + 96 })
  const version = await add('alice', 'new-weapon', weapon('second'))
  await add('alice', 'overflow', potion(94), 'BAG_FULL')
  await add('bob', 'foreign-instance', weapon('second'), 'INVALID_ITEM')
  const swap = command(1, version, { kind: 'equip', bagSlot: 23, slot: 'weapon', itemInstanceId: 'second' })
  const swappedVersion = await equip('alice', swap)
  await equip('alice', unequip(2, swappedVersion), 'SOURCE_CHANGED')
  const fullUnequip = command(3, swappedVersion, { kind: 'unequip', slot: 'weapon', itemInstanceId: 'second' })
  await equip('alice', fullUnequip, 'BAG_FULL')
  await equip('alice', { ...swap, available: false })
  await equip('alice', command(1, version, { ...swap.operation, slot: 'armor' }), 'REQUEST_CONFLICT')
  await equip('alice', command(4, version, swap.operation), 'STALE_VERSION')
  expect((await pgRepo.read('alice')).inventory.bag[23].itemInstanceId).toBe('starter:alice')
})

test('checks SQL identity, location, quantity, currency, version, ownership and receipt uniqueness', async () => {
  await main.repository.initialize('alice')
  await main.repository.initialize('bob')
  const contender = await session()
  const sql = 'INSERT INTO items VALUES ($1, $2, $3, $4, $5, $6)'
  const add = (id, location, instance, quantity) => main.client.query(sql, [id, location, 'training_sword', instance, quantity, '{}'])
  await expect(add('ghost', 3, 'x', 1)).rejects.toMatchObject({ code: '23503' })
  await expect(add('bob', 3, 'starter:alice', 1)).rejects.toMatchObject({ code: '23505', constraint: 'items_instance_id_key' })
  await expect(add('alice', 0, 'x', 1)).rejects.toMatchObject({ code: '23505', constraint: 'items_pkey' })
  await expect(add('alice', 24, 'x', 1)).rejects.toMatchObject({ code: '23505', constraint: 'items_pkey' })
  await expect(add('alice', 27, 'x', 1)).rejects.toMatchObject({ code: '23514' })
  await expect(add('alice', 25, null, 1)).rejects.toMatchObject({ code: '23514' })
  await expect(add('alice', 3, 'x', 2)).rejects.toMatchObject({ code: '23514' })
  await expect(add('alice', 3, null, 0)).rejects.toMatchObject({ code: '23514' })
  await expect(add('alice', 3, null, 100)).rejects.toMatchObject({ code: '23514' })
  await expect(main.client.query("UPDATE characters SET currency = -1 WHERE id = 'alice'")).rejects.toMatchObject({ code: '23514' })
  await expect(main.client.query("UPDATE characters SET currency = 2147483648 WHERE id = 'alice'")).rejects.toMatchObject({ code: '22003' })
  await expect(main.client.query("UPDATE characters SET version = 9007199254740992 WHERE id = 'alice'")).rejects.toMatchObject({
    code: '23514',
  })
  await main.client.query("INSERT INTO command_receipts VALUES ('alice', 'same', 'payload', 'CONFIRMED', false, 0)")
  await expect(
    contender.client.query("INSERT INTO command_receipts VALUES ('alice', 'same', 'other', 'CONFIRMED', false, 0)")
  ).rejects.toMatchObject({ code: '23505', constraint: 'command_receipts_pkey' })
  await contender.client.query("INSERT INTO command_receipts VALUES ('bob', 'same', 'other', 'CONFIRMED', false, 0)")
})

test('compares currency caps and no-op receipts with the memory repository port', async () => {
  const memory = createMemoryCharacterRepository(data.items)
  const coordinator = createCharacterCoordinator(data, () => {}, memory)
  coordinator.open('alice')
  await main.repository.initialize('alice')
  for (const [id, delta] of [-1, currencyLimit, 1, 0, -17].entries()) {
    const request = currencyRequest(id, delta)
    const current = memory.read('alice')
    const decision = changeCurrency(current.inventory, delta)
    const changed = !!decision.inventory && decision.inventory !== current.inventory
    const version = current.version + Number(changed)
    const receipt = { key: request.key, fingerprint: request.fingerprint, version, changed, code: decision.code ?? 'CONFIRMED' }
    const next = changed ? { ...current, inventory: decision.inventory, version } : current
    expect(await main.repository.execute('alice', request)).toEqual(
      memory.commit({ characterId: 'alice', expectedVersion: current.version, next, receipt })
    )
    expect(await main.repository.read('alice')).toEqual({ version: next.version, inventory: next.inventory })
  }
})

test('shows why immediate slot uniqueness rejects direct swaps and verifies a deferred alternative', async () => {
  await main.repository.initialize('alice')
  await main.repository.execute('alice', grantRequest('sword', weapon('second')))
  await main.repository.execute('alice', grantRequest('full', { itemDefinitionId: 'mp_potion', quantity: 21 * 99 + 96 }))
  const observer = await session()
  const swapSql = "UPDATE items SET location = CASE location WHEN 2 THEN 24 ELSE 2 END WHERE character_id = 'alice' AND location IN (2,24)"
  await expect(main.client.query("UPDATE items SET location = 24 WHERE instance_id = 'second'")).rejects.toMatchObject({ code: '23505' })
  await expect(main.client.query(swapSql)).rejects.toMatchObject({ code: '23505' })

  await main.client.query(
    'ALTER TABLE items DROP CONSTRAINT items_pkey, ADD PRIMARY KEY (character_id, location) DEFERRABLE INITIALLY IMMEDIATE'
  )
  await main.client.query('BEGIN')
  await main.client.query("SELECT id FROM characters WHERE id = 'alice' FOR UPDATE")
  await main.client.query('SET CONSTRAINTS items_pkey DEFERRED')
  await main.client.query("UPDATE items SET location = 24 WHERE instance_id = 'second'")
  expect((await observer.repository.read('alice')).inventory.equipment.weapon.itemInstanceId).toBe('starter:alice')
  await main.client.query("UPDATE items SET location = 2 WHERE instance_id = 'starter:alice'")
  await main.client.query('COMMIT')
  expect((await observer.repository.read('alice')).inventory.equipment.weapon.itemInstanceId).toBe('second')
  expect((await observer.repository.read('alice')).inventory.bag[2].itemInstanceId).toBe('starter:alice')

  await main.client.query('BEGIN')
  await main.client.query('SET CONSTRAINTS items_pkey DEFERRED')
  await main.client.query("UPDATE items SET location = 24 WHERE instance_id = 'starter:alice'")
  await expect(main.client.query('COMMIT')).rejects.toMatchObject({ code: '23505' })
  expect((await observer.repository.read('alice')).inventory.bag[2].itemInstanceId).toBe('starter:alice')
})

test('rolls back partial item writes and a staged receipt, then safely retries the same request', async () => {
  const before = await main.repository.initialize('alice')
  const observer = await session()
  const request = grantRequest('stack-retry', potion(199))
  const memory = createMemoryCharacterRepository(data.items)
  const coordinator = createCharacterCoordinator(data, () => {}, { ...memory, commit: (mutation) => commitMemory(mutation) })
  const fail = () => {
    throw new Error('injected before COMMIT')
  }
  let commitMemory = fail
  coordinator.open('alice')
  expect(() => coordinator.insert('alice', 'stack-retry', potion(199))).toThrow('injected before COMMIT')
  expect(memory.findReceipt('alice', request.key)).toBeUndefined()
  for (const hooks of [{ afterWrite: fail }, { beforeCommit: fail }]) {
    await expect(main.repository.execute('alice', request, hooks)).rejects.toThrow('injected before COMMIT')
    expect(await observer.repository.findReceipt('alice', request.key)).toBeUndefined()
    expect(await observer.repository.read('alice')).toEqual(before)
  }
  expect(await observer.repository.recover('alice', request)).toEqual({ kind: 'absentAfterLock' })
  commitMemory = memory.commit
  expect(coordinator.insert('alice', 'stack-retry', potion(199))).toBe('CONFIRMED')
  expect(await observer.repository.execute('alice', request)).toEqual({
    kind: 'committed',
    receipt: memory.findReceipt('alice', request.key),
  })
  const { inventory, version } = coordinator.read('alice')
  expect(await observer.repository.read('alice')).toEqual({ inventory, version })
  expect(await main.repository.execute('alice', request)).toMatchObject({ kind: 'replayed', receipt: { version: 1 } })
})

test('recovers lost application acknowledgment after COMMIT across new sessions and repository recreation', async () => {
  await main.repository.initialize('alice')
  const request = grantRequest('ack-lost', weapon('exactly-once'))
  const afterCommit = () => {
    throw new Error('application lost acknowledgment after COMMIT')
  }
  await expect(main.repository.execute('alice', request, { afterCommit })).rejects.toThrow('application lost acknowledgment')
  await main.client.end()
  connections.splice(connections.indexOf(main.client), 1)
  const replacement = await session()
  expect(await replacement.repository.execute('alice', currencyRequest('newer', 12))).toMatchObject({ receipt: { version: 2 } })
  const before = await replacement.repository.read('alice')
  const original = await replacement.repository.recover('alice', request)
  expect(original).toMatchObject({ kind: 'replayed', receipt: { code: 'CONFIRMED', version: 1, changed: true } })
  const recreated = createPgSpikeRepository(replacement.client, data.items)
  expect(await recreated.execute('alice', request)).toEqual(original)
  expect(await recreated.read('alice')).toEqual(before)
  expect(before.inventory.currency).toBe(12)
  expect(before.inventory.bag.filter((item) => item?.itemInstanceId === 'exactly-once')).toHaveLength(1)
})

test('loses a real TCP connection while awaiting the COMMIT response and recovers the original receipt', async () => {
  await main.repository.initialize('alice')
  const request = currencyRequest('wire-commit', 67)
  const proxy = await startCommitResponseProxy(port)
  try {
    const connection = await session(proxy.port)
    const connectionError = once(connection.client, 'error')
    await expect(connection.repository.execute('alice', request, { beforeCommit: proxy.arm })).rejects.toThrow('COMMIT outcome unknown')
    expect(await connectionError).toMatchObject([{ message: 'Connection terminated unexpectedly' }])
    expect(proxy.droppedCommit).toBe(true)
    const recovered = await main.repository.recover('alice', request)
    expect(recovered).toMatchObject({ kind: 'replayed', receipt: { version: 1, code: 'CONFIRMED' } })
    expect(await main.repository.execute('alice', request)).toEqual(recovered)
    expect(await main.repository.read('alice')).toMatchObject({ version: 1, inventory: { currency: 67 } })
  } finally {
    await proxy.close()
  }
})

test.each(['commit', 'rollback'])('fails closed while the original outcome is unknown, then observes %s', async (resolution) => {
  await main.repository.initialize('alice')
  const request = currencyRequest('pending', 50)
  const staged = barrier()
  const recovery = await session()
  const observer = await session()
  const original = main.repository.execute('alice', request, {
    async beforeCommit() {
      await staged.hold()
      if (resolution === 'rollback') throw new Error('injected rollback')
    },
  })
  const settledOriginal = original.catch((error) => error)
  await staged.entered
  let settledRecovery
  try {
    expect(await recovery.repository.findReceipt('alice', request.key)).toBeUndefined()
    expect(await recovery.repository.recover('alice', request, 100)).toEqual({ kind: 'unresolved' })
    const competing = observer.repository.execute('alice', currencyRequest('contended', 1), { lockMs: 100 })
    await expect(competing).rejects.toMatchObject({ code: '55P03' })
    settledRecovery = recovery.repository.recover('alice', request)
    await expectBlocked(observer.client, recovery.pid, main.pid)
  } finally {
    staged.release()
  }
  if (resolution === 'commit') {
    expect(await settledOriginal).toMatchObject({ kind: 'committed' })
    expect(await settledRecovery).toMatchObject({ kind: 'replayed', receipt: { version: 1 } })
  } else {
    expect(await settledOriginal).toMatchObject({ message: 'injected rollback' })
    expect(await settledRecovery).toEqual({ kind: 'absentAfterLock' })
    expect(await observer.repository.execute('alice', request)).toMatchObject({ kind: 'committed', receipt: { version: 1 } })
  }
  expect(await observer.repository.read('alice')).toMatchObject({ version: 1, inventory: { currency: 50 } })
})

test('applies delayed PG completions at tick boundaries across transfer, reconnect and death', async () => {
  const independent = await session()
  const alice = { ...(await main.repository.initialize('alice')), route: 'map-a/socket-1', hp: 32, mp: 8 }
  const bob = { ...(await independent.repository.initialize('bob')), route: 'map-a/socket-2', hp: 23, mp: 8 }
  const harness = createTickHarness(
    new Map([
      ['alice', alice],
      ['bob', bob],
    ])
  )
  const events = (kind, characterId) => harness.events.filter((event) => event.kind === kind && event.characterId === characterId)
  const staged = barrier()
  const interval = setInterval(harness.tick, 1000 / 30)
  try {
    harness.admit('alice', main.repository, unequip(1, 0), { afterLock: staged.hold })
    harness.admit('alice', main.repository, currencyRequest('after-equip', 20))
    await staged.entered
    const start = performance.now()
    const firstTick = harness.tickCount
    const release = delay(200).then(staged.release)
    alice.route = 'map-b/socket-3'
    alice.hp = 0
    alice.mp = 2
    alice.route = 'map-b/socket-4'
    expect(harness.admit('alice', main.repository, currencyRequest('after-death', 99))).toBe(false)
    bob.hp = 19
    bob.mp = 4
    harness.admit('bob', independent.repository, currencyRequest('independent', 7))
    await vi.waitFor(() => expect(bob.version).toBe(1), { timeout: 1500, interval: 10 })
    expect(alice.version).toBe(0)
    expect(bob).toMatchObject({ hp: 19, mp: 4 })
    expect(events('dispatched', 'alice')).toHaveLength(1)
    await release
    const elapsedMs = performance.now() - start
    const liveTicks = harness.tickCount - firstTick
    expect(liveTicks).toBeGreaterThanOrEqual(2)

    await vi.waitFor(() => expect(alice.version).toBe(2), { timeout: 2000, interval: 10 })
    const [first, second] = events('applied', 'alice')
    expect(first.tick).toBeGreaterThan(events('completed', 'alice')[0].tick)
    expect(second.tick).toBeGreaterThan(first.tick)
    expect(events('dispatched', 'alice')[1].tick).toBe(first.tick)
    expect(alice).toMatchObject({ route: 'map-b/socket-4', hp: 0, mp: 2, inventory: { currency: 20, equipment: { weapon: null } } })
    const old = events('completed', 'alice')[0].completion
    harness.deliver(old)
    harness.deliver(old)
    harness.tick()
    expect(events('applied', 'alice')).toHaveLength(2)
    expect(alice.version).toBe(2)

    harness.admit('bob', independent.repository, currencyRequest('rolled-back', 99), {
      beforeCommit() {
        throw new Error('tick transaction rollback')
      },
    })
    await vi.waitFor(() => expect(events('failed', 'bob')).toHaveLength(1), { timeout: 1500, interval: 10 })
    expect(events('applied', 'bob')).toHaveLength(1)
    expect(await independent.repository.read('bob')).toMatchObject({ version: 1, inventory: { currency: 7 } })
    log('Tick sample:', { elapsedMs: Math.round(elapsedMs), liveTicks })
  } finally {
    staged.release()
    clearInterval(interval)
  }
})

test('round-trips domain metadata that PostgreSQL jsonb rejects', async () => {
  const coordinator = createCharacterCoordinator(data, () => {})
  coordinator.open('alice')
  await main.repository.initialize('alice')
  const metadata = { escaped: '\u0000', unpaired: '\ud800' }
  const grant = potion(1, { metadata })
  expect(coordinator.insert('alice', 'metadata-edge', grant)).toBe('CONFIRMED')
  expect(outcome(await main.repository.execute('alice', grantRequest('metadata-edge', grant)))).toBe('CONFIRMED')
  expect((await main.repository.read('alice')).inventory).toEqual(coordinator.read('alice').inventory)
  await expect(main.client.query('SELECT $1::jsonb', [JSON.stringify({ escaped: metadata.escaped })])).rejects.toMatchObject({
    code: '22P05',
  })
  await expect(main.client.query('SELECT $1::jsonb', [JSON.stringify({ unpaired: metadata.unpaired })])).rejects.toMatchObject({
    code: '22P02',
  })
})

test('identifies item IDs the memory contract accepts but raw PostgreSQL text cannot store', async () => {
  const coordinator = createCharacterCoordinator(data, () => {})
  coordinator.open('alice')
  const before = await main.repository.initialize('alice')
  const item = weapon('sword\u0000identifier')
  const request = grantRequest('id-edge', item)
  expect(coordinator.insert('alice', 'id-edge', item)).toBe('CONFIRMED')
  await expect(main.repository.execute('alice', request)).rejects.toMatchObject({ code: '22021' })
  expect(await main.repository.read('alice')).toEqual(before)
  expect(await main.repository.findReceipt('alice', request.key)).toBeUndefined()
})

test('measures heap and index usage for representative opaque receipts', async () => {
  await main.repository.initialize('alice')
  await main.client.query(`INSERT INTO command_receipts
    SELECT 'alice', json_build_array('request', 'spike-play-lease', n)::text,
      '["equip",123,["weapon","starter:alice",2]]', 'CONFIRMED', true, n
    FROM generate_series(1, 1000) n`)
  const { rows } = await main.client
    .query(`SELECT count(*)::int AS receipts, round(avg(pg_column_size(command_receipts)), 1)::float AS tuple_bytes,
    pg_relation_size('command_receipts')::int AS heap_bytes, pg_indexes_size('command_receipts')::int AS index_bytes
    FROM command_receipts`)
  expect(rows[0]).toMatchObject({ receipts: 1000, tuple_bytes: expect.any(Number), index_bytes: expect.any(Number) })
  log('Receipt sample:', rows[0])
})
