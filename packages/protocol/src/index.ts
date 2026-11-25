export {
  maxCombatDamageAgeTicks,
  maxCombatDamageEvents,
  parseCombatDamageBatch,
  type CombatDamage,
  type CombatDamageBatch,
} from './combat-damage.js'
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
  parseAllocateAp,
  parseOwnerProgression,
  readApRequestId,
  type AllocateApRequest,
  type ApResultCode,
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
export const allocateApMessage = 'AllocateAP'
export const ownerProgressionMessage = 'OwnerProgression'
