import type { LootId } from '@viesma/domain'
import type { GroundLootView, MapRoomJoin, OwnerGroundLoot } from '@viesma/protocol'

export function matchesOwnerLoot(
  message: MapRoomJoin & { readonly mapInstanceId: string },
  binding: MapRoomJoin,
  mapInstanceId: string
): boolean {
  return (
    message.characterId === binding.characterId &&
    message.connectionEpoch === binding.connectionEpoch &&
    message.mapEpoch === binding.mapEpoch &&
    message.mapInstanceId === mapInstanceId
  )
}

export function createOwnerLootView() {
  let revision = -1
  let missingThrough = -1
  let loot: ReadonlyMap<LootId, GroundLootView> = new Map()
  return {
    loot: () => loot,
    receive(update: OwnerGroundLoot): boolean {
      if (update.kind === 'snapshot' && update.privateRevision < missingThrough) return true
      if (update.privateRevision <= revision) return false
      if (update.kind === 'snapshot') {
        loot = new Map(update.loot.map((item) => [item.lootId, item]))
        missingThrough = -1
      } else {
        if (missingThrough !== -1 || update.baseRevision !== revision) {
          const requestRefresh = missingThrough === -1
          missingThrough = Math.max(missingThrough, update.privateRevision)
          return requestRefresh
        }
        const next = new Map(loot)
        for (const id of update.removed) next.delete(id)
        for (const item of update.added) next.set(item.lootId, item)
        loot = next
      }
      revision = update.privateRevision
      return false
    },
  }
}
