import { expect, test, vi } from 'vitest'
import { createEncounterRewardWorker } from '../src/runtime/encounter-reward-worker.ts'

function createMemoryEncounterRewardPort() {
  const receipts = new Map()
  return {
    commitReward({ claim }) {
      if (!receipts.has(claim.deathId)) receipts.set(claim.deathId, Object.freeze({ ...claim, resultingVersions: [] }))
      return receipts.get(claim.deathId)
    },
    releaseReceipt: (deathId) => receipts.delete(deathId),
  }
}

async function flushProcessing() {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

function intentFor(deathId) {
  return Object.freeze({
    claim: Object.freeze({ deathId, monsterId: 'monster', generation: 2, encounterId: 'encounter' }),
    balanceVersion: 'mvp-1',
    groups: Object.freeze([]),
  })
}

test('keeps one immutable job across pre-commit failure, lost acknowledgement and repeated completion', async () => {
  const memory = createMemoryEncounterRewardPort()
  const commit = vi.fn(memory.commitReward)
  let finish
  const port = {
    ...memory,
    commitReward: vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('before commit')
      })
      .mockImplementationOnce((intent) => {
        commit(intent)
        return Promise.reject(new Error('acknowledgement lost'))
      })
      .mockImplementation(
        (intent) =>
          new Promise((resolve) => {
            finish = () => {
              resolve(commit(intent))
              resolve({ deathId: 'ignored' })
            }
          })
      ),
  }
  const worker = createEncounterRewardWorker(port)
  const intent = intentFor('one')
  expect(worker.accept(intent)).toBe(true)
  expect(worker.accept(intentFor('one'))).toBe(false)
  expect(worker.hasPending()).toBe(true)
  worker.advance()
  await flushProcessing()
  expect(commit).not.toHaveBeenCalled()
  expect(worker.receipt('one')).toBeUndefined()
  worker.advance()
  await flushProcessing()
  const committed = commit.mock.results[0].value
  expect(worker.receipt('one')).toBeUndefined()
  worker.advance()
  await flushProcessing()
  worker.advance()
  await flushProcessing()
  expect(port.commitReward).toHaveBeenCalledTimes(3)
  expect(port.commitReward.mock.calls.every(([received]) => received === intent)).toBe(true)
  finish()
  await flushProcessing()
  expect(worker.receipt('one')).toBeUndefined()
  worker.advance()
  expect(worker.receipt('one')).toBe(committed)
  expect(commit.mock.results.every(({ value }) => value === committed)).toBe(true)
  expect(committed).toEqual({ ...intent.claim, resultingVersions: [] })
  expect(worker.hasPending()).toBe(false)
  expect(worker.accept(intent)).toBe(false)
  worker.advance()
  expect(port.commitReward).toHaveBeenCalledTimes(3)
})

test.each([{ deathId: 'other' }, { monsterId: 'other' }, { generation: 1 }, { encounterId: 'old' }])(
  'retains detached work through a mismatched receipt %j and frees completed receipt state',
  async (mismatch) => {
    const memory = createMemoryEncounterRewardPort()
    const intent = intentFor('detached')
    const port = {
      releaseReceipt: vi.fn(memory.releaseReceipt),
      commitReward: vi.fn(memory.commitReward).mockReturnValueOnce({ ...intent.claim, ...mismatch, resultingVersions: [] }),
    }
    const worker = createEncounterRewardWorker(port)
    expect(worker.accept(intent)).toBe(true)
    worker.advance()
    worker.releaseEncounter('detached')
    worker.releaseEncounter('detached')
    await flushProcessing()
    worker.advance()
    expect(worker.hasPending()).toBe(true)
    expect(worker.receipt('detached')).toBeUndefined()
    expect(port.releaseReceipt).not.toHaveBeenCalled()
    await flushProcessing()
    worker.advance()
    expect(worker.hasPending()).toBe(false)
    expect(worker.receipt('detached')).toBeUndefined()
    expect(port.releaseReceipt).toHaveBeenCalledExactlyOnceWith('detached')
  }
)

test('pauses new combat admission at the pending threshold without discarding accepted work', async () => {
  const memory = createMemoryEncounterRewardPort()
  const port = { ...memory, commitReward: vi.fn(memory.commitReward) }
  const worker = createEncounterRewardWorker(port)
  for (let index = 1; index < 256; index++) worker.accept(intentFor(`death-${index}`))
  expect(worker.canAdmitAttacks()).toBe(true)
  worker.accept(intentFor('threshold'))
  expect(worker.canAdmitAttacks()).toBe(false)
  worker.accept(intentFor('in-flight-swing'))
  worker.advance()
  await flushProcessing()
  worker.advance()
  expect(worker.receipt('in-flight-swing')).toBeDefined()
  expect(worker.canAdmitAttacks()).toBe(true)
  expect(port.commitReward).toHaveBeenCalledTimes(257)
})
