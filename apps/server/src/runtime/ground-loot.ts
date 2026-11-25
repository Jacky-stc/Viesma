import type { CharacterId, GroundLootGrant, LootId, MapId, MapInstanceId, WorldPoint } from '@viesma/domain'
import { createLootPlacement, initialEncounterRewardBalance, type NormalizedMap } from '@viesma/game-data'
import type { GroundLootView } from '@viesma/protocol'
import { isDeepStrictEqual } from 'node:util'

export type CommittedLootRoll = Extract<GroundLootGrant, { readonly state: 'committed' }>
export type GroundDelivery = {
  readonly grant: CommittedLootRoll
  readonly mapInstanceId: MapInstanceId
  readonly position: WorldPoint
  readonly status: 'GROUND' | 'PICKED' | 'EXPIRED'
}

export interface GroundLootState {
  readonly revision: number
  readonly loot: ReadonlyMap<LootId, GroundLootView>
}

export function createGroundLootStore(maps: readonly NormalizedMap[]) {
  const placements = new Map(maps.map((map) => [map.id, createLootPlacement(map)]))
  const records = new Map<LootId, GroundDelivery>()
  const active = new Set<LootId>()
  const views = new Map<CharacterId, Map<MapInstanceId, GroundLootState>>()
  const emptyView: GroundLootState = { revision: 0, loot: new Map() }

  function publishView(delivery: GroundDelivery, visible = delivery.status === 'GROUND') {
    const { grant, mapInstanceId, position } = delivery
    let instances = views.get(grant.ownerCharacterId)
    if (!instances) {
      instances = new Map()
      views.set(grant.ownerCharacterId, instances)
    }
    const previous = instances.get(mapInstanceId)
    const loot = new Map(previous?.loot)
    if (visible) {
      const { lootId, expiresAtUtcMilliseconds, content } = grant
      loot.set(lootId, Object.freeze({ lootId, expiresAtUtcMilliseconds, content, position }))
    } else loot.delete(grant.lootId)
    instances.set(mapInstanceId, { revision: (previous?.revision ?? 0) + 1, loot })
  }

  function transition(delivery: GroundDelivery, status: 'PICKED' | 'EXPIRED'): void {
    const next = Object.freeze({ ...delivery, status })
    records.set(delivery.grant.lootId, next)
    active.delete(delivery.grant.lootId)
    publishView(next)
  }

  return {
    prepareDelivery(grants: readonly CommittedLootRoll[], mapId: MapId, mapInstanceId: MapInstanceId, nowUtc: number) {
      const placement = placements.get(mapId)
      if (!placement) throw new RangeError('Missing loot placement for delivery map')
      const staged = new Map<LootId, GroundDelivery>()
      for (const grant of grants) {
        if (grant.mapId !== mapId || grant.placement.sourceMapInstanceId !== mapInstanceId)
          throw new RangeError('Loot delivery does not match source instance')
        if (!Number.isSafeInteger(grant.expiresAtUtcMilliseconds) || grant.expiresAtUtcMilliseconds < 0)
          throw new RangeError('Invalid committed loot expiry')
        const previous = staged.get(grant.lootId) ?? records.get(grant.lootId)
        if (previous) {
          if (!isDeepStrictEqual(previous.grant, grant)) throw new Error('Conflicting committed loot identity')
          continue
        }
        staged.set(
          grant.lootId,
          Object.freeze({
            grant: Object.freeze({
              ...grant,
              content: Object.freeze({ ...grant.content }),
              placement: Object.freeze({ ...grant.placement, deathPosition: Object.freeze({ ...grant.placement.deathPosition }) }),
            }),
            mapInstanceId,
            position: Object.freeze({ ...placement.place(grant.placement.deathPosition) }),
            status: nowUtc < grant.expiresAtUtcMilliseconds ? 'GROUND' : 'EXPIRED',
          })
        )
      }
      return () => {
        // 再檢查整批 identity 後，在同一提交回合發布。
        for (const [id, delivery] of staged) {
          const existing = records.get(id)
          if (existing && !isDeepStrictEqual(existing.grant, delivery.grant)) throw new Error('Conflicting committed loot identity')
        }
        for (const [id, delivery] of staged) {
          if (records.has(id)) continue
          records.set(id, delivery)
          if (delivery.status === 'GROUND') {
            active.add(id)
            publishView(delivery)
          }
        }
      }
    },
    view(owner: CharacterId, instance: MapInstanceId): GroundLootState {
      return views.get(owner)?.get(instance) ?? emptyView
    },
    rebind(
      owner: CharacterId,
      mapId: MapId,
      destination: MapInstanceId,
      instanceExists: (id: MapInstanceId) => boolean,
      clock: () => number
    ): void {
      const instances = views.get(owner)
      if (!instances) return
      for (const [source, view] of instances) {
        if (source === destination || instanceExists(source)) continue
        for (const id of view.loot.keys()) {
          const current = records.get(id)
          if (!current || current.grant.mapId !== mapId || current.status !== 'GROUND') continue
          if (clock() >= current.grant.expiresAtUtcMilliseconds) {
            transition(current, 'EXPIRED')
            continue
          }
          const next = Object.freeze({ ...current, mapInstanceId: destination })
          records.set(id, next)
          publishView(current, false)
          publishView(next)
        }
      }
    },
    expire(clock: () => number): void {
      if (active.size === 0) return
      const nowUtc = clock()
      for (const id of active) {
        const delivery = records.get(id)
        if (delivery && delivery.grant.expiresAtUtcMilliseconds <= nowUtc) transition(delivery, 'EXPIRED')
      }
    },
    inspectPickup(id: LootId, owner: CharacterId, instance: MapInstanceId, feet: WorldPoint, nowUtc: number) {
      const delivery = records.get(id)
      if (!delivery || delivery.grant.ownerCharacterId !== owner || delivery.mapInstanceId !== instance || delivery.status === 'PICKED')
        return { code: 'LOOT_UNAVAILABLE' } as const
      if (delivery.status === 'EXPIRED' || nowUtc >= delivery.grant.expiresAtUtcMilliseconds) return { code: 'LOOT_EXPIRED' } as const
      const { x, y } = delivery.position
      const radius = initialEncounterRewardBalance.lootPickupRadiusWorldUnits
      if ((feet.x - x) ** 2 + (feet.y - y) ** 2 > radius ** 2) return { code: 'TOO_FAR' } as const
      return { delivery }
    },
    pick(delivery: GroundDelivery, nowUtc: number): boolean {
      if (
        records.get(delivery.grant.lootId) !== delivery ||
        delivery.status !== 'GROUND' ||
        nowUtc >= delivery.grant.expiresAtUtcMilliseconds
      )
        return false
      transition(delivery, 'PICKED')
      return true
    },
  }
}

export type GroundLootStore = ReturnType<typeof createGroundLootStore>
