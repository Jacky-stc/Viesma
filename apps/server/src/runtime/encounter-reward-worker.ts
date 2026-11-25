import type { DeathId, RewardReceipt } from '@viesma/domain'
import type { EncounterRewardIntent, MonsterDeathIdentity } from '@viesma/simulation'

type EncounterRewardReceipt = RewardReceipt & MonsterDeathIdentity

export interface EncounterRewardPort {
  // 同一 deathId 的處理須重用已提交的 receipt，即使先前的確認遺失。
  commitReward(intent: EncounterRewardIntent): EncounterRewardReceipt | Promise<EncounterRewardReceipt>
  releaseReceipt(deathId: DeathId): void
}

export function createMemoryEncounterRewardPort(): EncounterRewardPort {
  const receipts = new Map<DeathId, EncounterRewardReceipt>()
  return {
    commitReward({ claim: { deathId, monsterId, generation, encounterId } }) {
      const existing = receipts.get(deathId)
      if (existing) return existing
      const receipt = Object.freeze({ deathId, monsterId, generation, encounterId, resultingVersions: Object.freeze([]) })
      receipts.set(deathId, receipt)
      return receipt
    },
    releaseReceipt(deathId) {
      receipts.delete(deathId)
    },
  }
}

interface RewardJob {
  readonly intent: EncounterRewardIntent
  readonly commitProgression: (() => RewardReceipt['resultingVersions']) | undefined
  retainedByEncounter: boolean
  state:
    { readonly kind: 'ready' } | { readonly kind: 'processing' } | { readonly kind: 'committed'; readonly receipt: EncounterRewardReceipt }
}

const pendingAdmissionLimit = 256

export function createEncounterRewardWorker(
  port: EncounterRewardPort = createMemoryEncounterRewardPort(),
  prepareProgression?: (intent: EncounterRewardIntent) => () => RewardReceipt['resultingVersions']
) {
  const jobs = new Map<DeathId, RewardJob>()
  const completions = new Map<DeathId, EncounterRewardReceipt | undefined>()
  let pending = 0

  function release(deathId: DeathId) {
    jobs.delete(deathId)
    port.releaseReceipt(deathId)
  }

  return {
    canAdmitAttacks: () => pending < pendingAdmissionLimit,
    hasPending: () => pending !== 0,
    accept(intent: EncounterRewardIntent): boolean {
      const { deathId } = intent.claim
      if (jobs.has(deathId)) return false
      jobs.set(deathId, { intent, commitProgression: prepareProgression?.(intent), retainedByEncounter: true, state: { kind: 'ready' } })
      pending++
      return true
    },
    receipt(deathId: DeathId): EncounterRewardReceipt | undefined {
      const state = jobs.get(deathId)?.state
      return state?.kind === 'committed' ? state.receipt : undefined
    },
    releaseEncounter(deathId: DeathId): void {
      const job = jobs.get(deathId)
      if (!job) return
      job.retainedByEncounter = false
      if (job.state.kind === 'committed') release(deathId)
    },
    advance(): void {
      for (const [deathId, receipt] of completions) {
        const job = jobs.get(deathId)
        if (job?.state.kind !== 'processing') continue
        const { monsterId, generation, encounterId } = job.intent.claim
        if (
          receipt?.deathId !== deathId ||
          receipt.monsterId !== monsterId ||
          receipt.generation !== generation ||
          receipt.encounterId !== encounterId
        ) {
          job.state = { kind: 'ready' }
          continue
        }
        const resultingVersions = job.commitProgression?.()
        job.state = {
          kind: 'committed',
          receipt: resultingVersions ? Object.freeze({ ...receipt, resultingVersions }) : receipt,
        }
        pending--
        if (!job.retainedByEncounter) release(deathId)
      }
      completions.clear()

      for (const [deathId, job] of jobs) {
        if (job.state.kind !== 'ready') continue
        job.state = { kind: 'processing' }
        void Promise.resolve()
          .then(() => port.commitReward(job.intent))
          .then(
            (receipt) => completions.set(deathId, receipt),
            () => completions.set(deathId, undefined)
          )
      }
    },
  }
}

export type EncounterRewardWorker = ReturnType<typeof createEncounterRewardWorker>
