import type { MapState, SimulationTick } from '@viesma/domain'
import type { PublicRoomHeader } from '@viesma/protocol'

/** 將房間識別投影為可交給 Colyseus transport 的 plain DTO。 */
export function projectPublicRoomHeader(map: Pick<MapState, 'mapInstanceId'>, tick: SimulationTick): PublicRoomHeader {
  return { mapInstanceId: map.mapInstanceId, serverTick: tick }
}
