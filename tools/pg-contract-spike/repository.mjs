import { bagSlotCount, equipmentSlots } from '@viesma/domain'
import { changeCurrency, changeEquipment, createStarterInventory, insertInventory, parseInventoryGrant } from '@viesma/simulation'
import { isDeepStrictEqual } from 'node:util'

export function equipmentRequest(request, available = true) {
  return { ...request, available }
}

export function grantRequest(id, grant) {
  const normalized = parseInventoryGrant(grant)
  if (!normalized) throw new Error('Invalid spike grant fixture')
  return {
    key: JSON.stringify(['inventory', id]),
    fingerprint: JSON.stringify(normalized),
    operation: { kind: 'grant', grant: normalized },
  }
}

export function currencyRequest(id, delta) {
  return { key: JSON.stringify(['currency', id]), fingerprint: JSON.stringify(delta), operation: { kind: 'currency', delta } }
}

async function transaction(client, work, { lockMs = 1200, beforeCommit, afterCommit } = {}) {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  let result
  try {
    await client.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', '6s', true)", [`${lockMs}ms`])
    result = await work()
    await beforeCommit?.()
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
  try {
    await client.query('COMMIT')
  } catch (error) {
    throw new Error('COMMIT outcome unknown', { cause: error })
  }
  await afterCommit?.()
  return result
}

export function createPgSpikeRepository(client, definitions) {
  async function findReceipt(characterId, key) {
    const { rows } = await client.query(
      'SELECT request_key AS key, fingerprint, code, changed, version FROM command_receipts WHERE character_id = $1 AND request_key = $2',
      [characterId, key]
    )
    const [row] = rows
    return row && { ...row, version: Number(row.version) }
  }

  async function characterRow(characterId, lock = false) {
    const { rows } = await client.query(`SELECT version, currency FROM characters WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [characterId])
    return rows[0]
  }

  async function readLocked(characterId, row) {
    const bag = Array(bagSlotCount).fill(null)
    const equipment = { weapon: null, armor: null, accessory: null }
    const { rows } = await client.query('SELECT * FROM items WHERE character_id = $1 ORDER BY location', [characterId])
    for (const { location, definition_id, instance_id, quantity, metadata } of rows) {
      const fields = { itemDefinitionId: definition_id, quantity, metadata }
      const item = instance_id === null ? { kind: 'stack', ...fields } : { kind: 'equipment', itemInstanceId: instance_id, ...fields }
      if (location < bagSlotCount) bag[location] = item
      else equipment[equipmentSlots[location - bagSlotCount]] = item
    }
    return { version: Number(row.version), inventory: { bag, equipment, currency: row.currency } }
  }

  async function writeInventory(characterId, previous, inventory) {
    const locations = (value) => [...value.bag, ...equipmentSlots.map((slot) => value.equipment[slot])]
    const originals = previous ? locations(previous) : []
    const changes = locations(inventory).flatMap((item, location) =>
      isDeepStrictEqual(item, originals[location] ?? null) ? [] : [{ item, location }]
    )
    await client.query('DELETE FROM items WHERE character_id = $1 AND location = ANY($2::smallint[])', [
      characterId,
      changes.map(({ location }) => location),
    ])
    for (const { item, location } of changes) {
      if (item === null) continue
      await client.query('INSERT INTO items VALUES ($1, $2, $3, $4, $5, $6)', [
        characterId,
        location,
        item.itemDefinitionId,
        item.itemInstanceId ?? null,
        item.quantity,
        JSON.stringify(item.metadata),
      ])
    }
  }

  function decide(current, request) {
    const { operation } = request
    if (operation.kind === 'grant') return insertInventory(current.inventory, operation.grant, definitions)
    if (operation.kind === 'currency') return changeCurrency(current.inventory, operation.delta)
    if (!request.available) return { code: 'UNAVAILABLE' }
    if (request.expectedCharacterVersion !== current.version) return { code: 'STALE_VERSION' }
    return changeEquipment(current.inventory, operation, 1, definitions)
  }

  return {
    findReceipt,
    async read(characterId) {
      // 一次 read snapshot 避免角色列與 item 列來自不同已提交版本。
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        const row = await characterRow(characterId)
        return row && (await readLocked(characterId, row))
      } finally {
        await client.query('ROLLBACK')
      }
    },
    async initialize(characterId, hooks = {}) {
      return transaction(
        client,
        async () => {
          const inserted = await client.query('INSERT INTO characters (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [characterId])
          const row = await characterRow(characterId, true)
          if (inserted.rowCount) await writeInventory(characterId, undefined, createStarterInventory(definitions, `starter:${characterId}`))
          await hooks.afterWrite?.()
          return readLocked(characterId, row)
        },
        hooks
      )
    },
    async execute(characterId, request, hooks = {}) {
      return transaction(
        client,
        async () => {
          const row = await characterRow(characterId, true)
          if (!row) return { kind: 'missing' }
          await hooks.afterLock?.()
          const { key, fingerprint } = request
          const previous = await findReceipt(characterId, key)
          if (previous) return previous.fingerprint === fingerprint ? { kind: 'replayed', receipt: previous } : { kind: 'conflict' }

          const current = await readLocked(characterId, row)
          const decision = decide(current, request)
          let code = decision.code ?? 'CONFIRMED'
          let changed = decision.inventory !== undefined && decision.inventory !== current.inventory
          if (changed && !Number.isSafeInteger(current.version + 1)) return { kind: 'stale' }
          if (changed) {
            await client.query('SAVEPOINT inventory_write')
            try {
              await writeInventory(characterId, current.inventory, decision.inventory)
            } catch (error) {
              if (error.code !== '23505' || error.constraint !== 'items_instance_id_key') throw error
              await client.query('ROLLBACK TO SAVEPOINT inventory_write')
              code = 'INVALID_ITEM'
              changed = false
            }
            await client.query('RELEASE SAVEPOINT inventory_write')
          }
          const version = current.version + Number(changed)
          if (changed) {
            await client.query('UPDATE characters SET version = $2, currency = $3 WHERE id = $1', [
              characterId,
              version,
              decision.inventory.currency,
            ])
            await hooks.afterWrite?.()
          }
          await client.query('INSERT INTO command_receipts VALUES ($1, $2, $3, $4, $5, $6)', [
            characterId,
            key,
            fingerprint,
            code,
            changed,
            version,
          ])
          return { kind: 'committed', receipt: { key, fingerprint, code, changed, version } }
        },
        hooks
      )
    },
    async recover(characterId, { key, fingerprint }, lockMs) {
      function match(receipt) {
        return receipt.fingerprint === fingerprint ? { kind: 'replayed', receipt } : { kind: 'conflict' }
      }
      const existing = await findReceipt(characterId, key)
      if (existing) return match(existing)
      try {
        return await transaction(
          client,
          async () => {
            const row = await characterRow(characterId, true)
            if (!row) return { kind: 'unresolved' }
            // 鎖取得後以 READ COMMITTED 新 statement 觀察前一筆交易的提交結果。
            const settled = await findReceipt(characterId, key)
            return settled ? match(settled) : { kind: 'absentAfterLock' }
          },
          { lockMs }
        )
      } catch (error) {
        if (error.code === '55P03') return { kind: 'unresolved' }
        throw error
      }
    },
  }
}
