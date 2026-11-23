import type { MapId } from '@viesma/domain'
import type { MapPoint, NormalizedMap } from './tiled/types.js'
import { array, freeze, id, integer, invalid, name, record } from './validation.js'

export interface GuideDefinition {
  readonly mapId: MapId
  readonly npc: MapPoint
  readonly interactionDistanceWorldUnits: number
  readonly title: string
  readonly lines: readonly string[]
}

const guideSource = {
  mapId: 'village',
  npcId: 'npc_guide',
  interactionDistanceWorldUnits: 96,
  title: 'Guide',
  lines: [
    '用 ←／→ 或 A／D 移動、Space 跳躍、J 攻擊，觸控也有對應按鈕。',
    '受傷時可用 HP 藥水，按 1 或觸控 HP。倒地 3 秒後會回到村莊。',
    '組隊時須存活、在線並留在同一房間。靠近倒下的怪物且近期實際造成足夠傷害的隊員，才有資格分享獎勵。',
    '站進傳送門後按 ↑／W 或觸控 ↑。村內由西向東通往 M3、M1、M2、M4。',
    '從 M1 的單向橋可前往 M5，穿過 M2 平原可前往 M6。',
  ],
}

export function loadGuideDefinition(maps: ReadonlyMap<MapId, NormalizedMap>): GuideDefinition {
  const value = record(guideSource, 'guide', ['mapId', 'npcId', 'interactionDistanceWorldUnits', 'title', 'lines'])
  const mapId = id<MapId>(value.mapId, 'guide.mapId')
  const npcId = id(value.npcId, 'guide.npcId')
  const npc = maps.get(mapId)?.npcs.find(({ id }) => id === npcId)
  if (!npc) invalid('INVALID_REFERENCE', 'guide.npcId', `Missing Npc "${npcId}" on "${mapId}"`)
  return freeze({
    mapId,
    npc,
    interactionDistanceWorldUnits: integer(value.interactionDistanceWorldUnits, 'guide.interactionDistanceWorldUnits', 1),
    title: name(value.title, 'guide.title'),
    lines: array(value.lines, 'guide.lines', name, 1),
  })
}
