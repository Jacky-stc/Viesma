import { isNonNegativeSafeInteger, type WorldPoint } from '@viesma/domain'
import { isWireId } from './map-room.js'

export const maxCombatDamageEvents = 128
export const maxCombatDamageAgeTicks = 12

type DamageTarget =
  | { readonly kind: 'monster'; readonly generation: number }
  | { readonly kind: 'player'; readonly lifeStartedTick: number; readonly mapEpoch: number }

export type CombatDamage = WorldPoint &
  DamageTarget & {
    readonly id: number
    readonly tick: number
    readonly targetId: string
    readonly amount: number
    readonly critical: boolean
  }

export interface CombatDamageBatch {
  readonly mapInstanceId: string
  readonly serverTick: number
  readonly events: readonly CombatDamage[]
}

export function parseCombatDamageBatch(value: unknown): CombatDamageBatch | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { mapInstanceId, serverTick, events } = value as Partial<Record<keyof CombatDamageBatch, unknown>>
  if (!isWireId(mapInstanceId) || !isNonNegativeSafeInteger(serverTick) || !Array.isArray(events) || events.length > maxCombatDamageEvents)
    return undefined

  const parsed: CombatDamage[] = []
  let previousId = 0
  let previousTick = 0
  for (const event of events as unknown[]) {
    if (typeof event !== 'object' || event === null) return undefined
    const { id, tick, targetId, amount, critical, x, y, kind, generation, lifeStartedTick, mapEpoch } = event as Record<string, unknown>
    if (
      !isNonNegativeSafeInteger(id) ||
      id <= previousId ||
      !isNonNegativeSafeInteger(tick) ||
      tick < previousTick ||
      tick > serverTick ||
      serverTick - tick > maxCombatDamageAgeTicks ||
      !isWireId(targetId) ||
      !isNonNegativeSafeInteger(amount) ||
      amount === 0 ||
      typeof critical !== 'boolean' ||
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      typeof y !== 'number' ||
      !Number.isFinite(y)
    )
      return undefined
    const fields = { id, tick, targetId, amount, critical, x, y }
    if (kind === 'monster' && isNonNegativeSafeInteger(generation) && generation > 0) {
      parsed.push({ ...fields, kind, generation })
    } else if (
      kind === 'player' &&
      isNonNegativeSafeInteger(lifeStartedTick) &&
      lifeStartedTick <= tick &&
      isNonNegativeSafeInteger(mapEpoch)
    ) {
      parsed.push({ ...fields, kind, lifeStartedTick, mapEpoch })
    } else {
      return undefined
    }
    previousId = id
    previousTick = tick
  }
  return { mapInstanceId, serverTick, events: parsed }
}
