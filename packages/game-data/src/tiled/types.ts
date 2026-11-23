import type { MapId, WorldPoint } from '@viesma/domain'
import type { Aabb, PhysicsWorldDefinition, PlatformCollider } from '@viesma/physics'
import type { MonsterArchetypeId, PortalDefinition, SpawnId } from '../types.js'

export interface NormalizedTileset {
  readonly source: string
  readonly image: string
  readonly imageWidth: number
  readonly imageHeight: number
  readonly columns: number
  readonly tileCount: number
  readonly margin: number
  readonly spacing: number
}

export interface NormalizedTile {
  readonly tileset: string
  readonly tileId: number
  readonly flipHorizontal: boolean
  readonly flipVertical: boolean
  readonly flipDiagonal: boolean
}

export interface NormalizedTileLayer {
  readonly name: string
  readonly visible: boolean
  readonly opacity: number
  readonly cells: readonly (NormalizedTile | null)[]
}

export interface MapCollider extends PlatformCollider {
  readonly id: string
}

export interface MapPlayerSpawn {
  readonly id: SpawnId
  /** 角色碰撞盒左上角。 */
  readonly position: WorldPoint
  readonly facing: 'left' | 'right'
}

export interface MapPortal extends PortalDefinition {
  readonly bounds: Aabb
}

interface MonsterSpawnFields {
  readonly id: SpawnId
  readonly monsterArchetypeId: MonsterArchetypeId
  readonly level: number
  readonly position: WorldPoint
}

export type MapMonsterSpawn = MonsterSpawnFields &
  (
    | { readonly movement: 'ground'; readonly floorId: string; readonly patrolMinX: number; readonly patrolMaxX: number }
    | { readonly movement: 'flight'; readonly flightBounds: Aabb }
  )

export interface MapPoint {
  readonly id: string
  readonly position: WorldPoint
}

export interface NormalizedMap extends PhysicsWorldDefinition {
  readonly id: MapId
  readonly widthTiles: number
  readonly heightTiles: number
  readonly tileSizeWorldUnits: number
  readonly tilesets: readonly NormalizedTileset[]
  readonly tileLayers: readonly NormalizedTileLayer[]
  readonly colliders: readonly MapCollider[]
  readonly spawns: readonly MapPlayerSpawn[]
  readonly portals: readonly MapPortal[]
  readonly monsterSpawns: readonly MapMonsterSpawn[]
  readonly npcs: readonly MapPoint[]
  readonly lootFallbacks: readonly MapPoint[]
}
