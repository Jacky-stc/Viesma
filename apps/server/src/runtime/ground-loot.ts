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
  let mutationVersion = 0

  function nextView(delivery: GroundDelivery, previous: GroundLootState | undefined, visible: boolean): GroundLootState {
    const { grant, position } = delivery
    const loot = new Map(previous?.loot)
    if (visible) {
      const { lootId, expiresAtUtcMilliseconds, content } = grant
      loot.set(lootId, Object.freeze({ lootId, expiresAtUtcMilliseconds, content, position }))
    } else loot.delete(grant.lootId)
    return { revision: (previous?.revision ?? 0) + 1, loot }
  }

  function publishView(delivery: GroundDelivery, visible = delivery.status === 'GROUND') {
    const { grant, mapInstanceId } = delivery
    let instances = views.get(grant.ownerCharacterId)
    if (!instances) {
      instances = new Map()
      views.set(grant.ownerCharacterId, instances)
    }
    instances.set(mapInstanceId, nextView(delivery, instances.get(mapInstanceId), visible))
  }

  function transition(delivery: GroundDelivery, status: 'PICKED' | 'EXPIRED'): void {
    const next = Object.freeze({ ...delivery, status })
    records.set(delivery.grant.lootId, next)
    active.delete(delivery.grant.lootId)
    publishView(next)
    mutationVersion++
  }

  function place(mapId: MapId, deathPosition: WorldPoint): WorldPoint {
    const placement = placements.get(mapId)
    if (!placement) throw new RangeError('Missing loot placement for delivery map')
    return Object.freeze(placement.place(deathPosition))
  }

  return {
    place,
    prepareDelivery(
      grants: readonly CommittedLootRoll[],
      mapId: MapId,
      mapInstanceId: MapInstanceId,
      nowUtc: number,
      frozenPosition?: WorldPoint
    ) {
      if (!placements.has(mapId)) throw new RangeError('Missing loot placement for delivery map')
      const expectedVersion = mutationVersion
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
            position: frozenPosition ?? place(mapId, grant.placement.deathPosition),
            status: nowUtc < grant.expiresAtUtcMilliseconds ? 'GROUND' : 'EXPIRED',
          })
        )
      }
      const ownerViews = new Map<CharacterId, Map<MapInstanceId, GroundLootState>>()
      for (const delivery of staged.values()) {
        if (delivery.status !== 'GROUND') continue
        const owner = delivery.grant.ownerCharacterId
        const instances = ownerViews.get(owner) ?? new Map(views.get(owner))
        instances.set(mapInstanceId, nextView(delivery, instances.get(mapInstanceId), true))
        ownerViews.set(owner, instances)
      }
      return {
        validate() {
          if (expectedVersion !== mutationVersion) throw new Error('Stale staged ground delivery')
        },
        publish() {
          for (const [id, delivery] of staged) {
            records.set(id, delivery)
            if (delivery.status === 'GROUND') active.add(id)
          }
          for (const [owner, instances] of ownerViews) views.set(owner, instances)
          if (staged.size) mutationVersion++
        },
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
          mutationVersion++
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
