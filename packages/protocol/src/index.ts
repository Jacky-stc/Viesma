export {
  maxCombatDamageAgeTicks,
  maxCombatDamageEvents,
  parseCombatDamageBatch,
  type CombatDamage,
  type CombatDamageBatch,
} from './combat-damage.js'
export {
  isLootResultCode,
  parseGroundLootRefresh,
  parseGroundLootRequest,
  parseOwnerGroundLoot,
  parseOwnerLootCommandResult,
  type GroundLootOperation,
  type GroundLootRequest,
  type GroundLootView,
  type LootResultCode,
  type OwnerGroundLoot,
  type OwnerLootCommandResult,
} from './ground-loot.js'
export {
  isEquipmentResultCode,
  parseEquipmentRequest,
  parseOwnerInventory,
  type EquipmentRequest,
  type EquipmentResultCode,
  type InventoryItemView,
  type OwnerInventory,
} from './inventory.js'
export { PROTOCOL_VERSION, checkJoinVersion, type JoinVersion, type JoinVersionResult } from './join-version.js'
export { parseInputFrame, parseMapRoomJoin } from './map-room.js'
export type { InputFrame, MapRoomJoin, PublicMapRoom, PublicMonster, PublicPlayer, PublicRoomHeader } from './map-room.js'
export {
  parseMapAdmission,
  parseMapRoomSession,
  parsePortalRequest,
  parseTransferCancellation,
  parseTransferFailure,
  parseTransferOffer,
  type MapAdmission,
  type MapRoomSession,
  type OnlineMapId,
  type PortalRequest,
  type TransferFailure,
  type TransferOffer,
} from './map-travel.js'
export { parseMovementCheckpoint, type MovementCheckpoint } from './movement-checkpoint.js'
export {
  isApResultCode,
  parseAllocateAp,
  parseOwnerProgression,
  readCharacterRequestId,
  type AllocateApRequest,
  type ApResultCode,
  type CharacterRequestHeader,
  type OwnerProgression,
} from './progression.js'

export const mapRoomName = 'map'
export const villageMapRoomName = 'village'
export const inputFrameMessage = 'InputFrame'
export const mapRoomJoinedMessage = 'MapRoomJoined'
export const movementCheckpointMessage = 'MovementCheckpoint'
export const combatDamageMessage = 'CombatDamage'
export const interactPortalMessage = 'InteractPortal'
export const transferOfferMessage = 'TransferOffer'
export const transferFailureMessage = 'TransferFailure'
export const cancelTransferMessage = 'CancelTransfer'

export const equipmentMessage = 'ChangeEquipment'
export const ownerInventoryMessage = 'OwnerInventory'
export const allocateApMessage = 'AllocateAP'
export const ownerProgressionMessage = 'OwnerProgression'
export const pickupLootMessage = 'PickupLoot'
export const consumeItemMessage = 'ConsumeItem'
export const ownerGroundLootMessage = 'OwnerGroundLoot'
export const refreshGroundLootMessage = 'RefreshGroundLoot'
export const ownerLootCommandResultMessage = 'OwnerLootCommandResult'
