export { PROTOCOL_VERSION, checkJoinVersion, type JoinVersion, type JoinVersionResult } from './join-version.js'
export { parseInputFrame, parseMapRoomJoin } from './map-room.js'
export type { InputFrame, MapRoomJoin, PublicMapRoom, PublicMonster, PublicPlayer, PublicRoomHeader } from './map-room.js'
export { parseMovementCheckpoint, type MovementCheckpoint } from './movement-checkpoint.js'

export const mapRoomName = 'map'
export const inputFrameMessage = 'InputFrame'
export const mapRoomJoinedMessage = 'MapRoomJoined'
export const movementCheckpointMessage = 'MovementCheckpoint'
