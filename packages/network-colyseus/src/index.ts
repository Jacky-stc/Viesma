import { schema, t } from '@colyseus/schema'
import { isNonNegativeSafeInteger, type MapState, type SimulationTick } from '@viesma/domain'
import type { PublicMapRoom, PublicMonster, PublicPlayer, PublicRoomHeader } from '@viesma/protocol'

const PlayerSchema = schema(
  {
    characterId: t.string(),
    x: t.float64(),
    y: t.float64(),
    state: t.string(),
    facing: t.string(),
    hp: t.float64(),
    maxHp: t.float64(),
    mapEpoch: t.float64(),
    lifeStartedTick: t.float64(),
    spawnProtected: t.boolean(),
  },
  'ViesmaPlayer'
)

const MonsterSchema = schema(
  {
    monsterId: t.string(),
    archetypeId: t.string(),
    x: t.float64(),
    y: t.float64(),
    state: t.string(),
    facing: t.string(),
    hp: t.float64(),
    maxHp: t.float64(),
    generation: t.float64(),
  },
  'ViesmaMonster'
)

export const MapRoomSchema = schema(
  {
    mapInstanceId: t.string(),
    mapId: t.string(),
    mapContentHash: t.string(),
    serverTick: t.float64(),
    players: t.map(PlayerSchema),
    monsters: t.map(MonsterSchema),
  },
  'ViesmaMapRoom'
)
export type MapRoomState = InstanceType<typeof MapRoomSchema>

export function updateMapRoomSchema(state: MapRoomState, { players, monsters, ...header }: PublicMapRoom): void {
  state.assign(header)
  const present = new Set<string>()
  for (const player of players) {
    present.add(player.characterId)
    const current = state.players.get(player.characterId)
    if (current) current.assign(player)
    else state.players.set(player.characterId, new PlayerSchema(player))
  }
  for (const id of state.players.keys()) {
    if (!present.has(id)) state.players.delete(id)
  }

  present.clear()
  for (const monster of monsters) {
    present.add(monster.monsterId)
    const current = state.monsters.get(monster.monsterId)
    if (current) current.assign(monster)
    else state.monsters.set(monster.monsterId, new MonsterSchema(monster))
  }
  for (const id of state.monsters.keys()) {
    if (!present.has(id)) state.monsters.delete(id)
  }
}

export function readPublicPlayers(state: MapRoomState): PublicPlayer[] {
  const players: PublicPlayer[] = []
  for (const [id, player] of state.players) {
    const { characterId, x, y, state: action, facing, hp, maxHp, mapEpoch, lifeStartedTick, spawnProtected } = player
    if (
      id !== characterId ||
      !isNonNegativeSafeInteger(mapEpoch) ||
      !isNonNegativeSafeInteger(lifeStartedTick) ||
      lifeStartedTick > state.serverTick ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isSafeInteger(hp) ||
      !Number.isSafeInteger(maxHp) ||
      maxHp <= 0 ||
      hp < 0 ||
      hp > maxHp ||
      typeof spawnProtected !== 'boolean' ||
      (facing !== 'left' && facing !== 'right')
    )
      continue
    switch (action) {
      case 'idle':
      case 'run':
      case 'jump':
      case 'fall':
      case 'attack':
      case 'hurt':
      case 'death':
        players.push({ characterId, x, y, state: action, facing, hp, maxHp, mapEpoch, lifeStartedTick, spawnProtected })
    }
  }
  return players
}

export function readPublicMonsters(state: MapRoomState): PublicMonster[] {
  const monsters: PublicMonster[] = []
  for (const [id, monster] of state.monsters) {
    const { monsterId, generation, archetypeId, x, y, state: action, facing, hp, maxHp } = monster
    if (
      id !== monsterId ||
      !monsterId ||
      !isNonNegativeSafeInteger(generation) ||
      generation === 0 ||
      !archetypeId ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isSafeInteger(maxHp) ||
      maxHp <= 0 ||
      !Number.isSafeInteger(hp) ||
      hp < 0 ||
      hp > maxHp ||
      (facing !== 'left' && facing !== 'right')
    )
      continue
    const defeated = action === 'rewardPending' || action === 'dead' || action === 'respawnWait'
    const alive = action === 'patrol' || action === 'attack' || action === 'spawning'
    if ((defeated && hp === 0) || (alive && hp > 0)) {
      monsters.push({ monsterId, generation, archetypeId, x, y, state: action, facing, hp, maxHp })
    }
  }
  return monsters.sort((left, right) => (left.monsterId < right.monsterId ? -1 : Number(left.monsterId > right.monsterId)))
}

/** 將房間識別投影為可交給 Colyseus transport 的 plain DTO。 */
export function projectPublicRoomHeader(map: Pick<MapState, 'mapInstanceId'>, tick: SimulationTick): PublicRoomHeader {
  return { mapInstanceId: map.mapInstanceId, serverTick: tick }
}
