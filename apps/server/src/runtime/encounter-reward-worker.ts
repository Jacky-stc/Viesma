import type { DeathId } from '@viesma/domain'
import type { EncounterRewardIntent } from '@viesma/simulation'
import type { EncounterRewardReceipt } from './memory-personal-loot.ts'

export interface EncounterRewardPort {
  // 同一 deathId 的處理須重用已提交的 receipt，即使先前的確認遺失。
  commitReward(intent: EncounterRewardIntent): EncounterRewardReceipt | Promise<EncounterRewardReceipt>
  releaseReceipt(deathId: DeathId): void
}

interface RewardJob {
  readonly intent: EncounterRewardIntent
  readonly releaseRecipients: (() => void) | undefined
  retainedByEncounter: boolean
  state:
    { readonly kind: 'ready' } | { readonly kind: 'processing' } | { readonly kind: 'committed'; readonly receipt: EncounterRewardReceipt }
}

const pendingAdmissionLimit = 256

export function createEncounterRewardWorker(
  port: EncounterRewardPort,
  retainRecipients?: (intent: EncounterRewardIntent) => () => void,
  applyCompletion?: (intent: EncounterRewardIntent, receipt: EncounterRewardReceipt) => void
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
      jobs.set(deathId, { intent, releaseRecipients: retainRecipients?.(intent), retainedByEncounter: true, state: { kind: 'ready' } })
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
        job.state = { kind: 'committed', receipt }
        pending--
        try {
          applyCompletion?.(job.intent, receipt)
        } finally {
          job.releaseRecipients?.()
          if (!job.retainedByEncounter && jobs.has(deathId)) release(deathId)
        }
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
