import { initialPhysicsBalance, loadGrayboxGameData } from '@viesma/game-data'

export const movementSmokeMaxPlayerX = 600

export function movementSmokeData(data = loadGrayboxGameData()) {
  const map = data.tiledMaps.find(({ id }) => id === 'm1')
  const slime = map?.monsterSpawns.find(({ id }) => id === 'spawn_slime_1')
  if (slime?.movement !== 'ground') throw new Error('Movement smoke requires the M1 entrance Slime')

  // 維持原巡邏寬度與地板，將入口 Slime 移到同步測試路線以東。
  const offset = 768 - slime.position.x
  const patrollingSlime = {
    ...slime,
    position: { ...slime.position, x: slime.position.x + offset },
    patrolMinX: slime.patrolMinX + offset,
    patrolMaxX: slime.patrolMaxX + offset,
  }
  const { position, patrolMinX, patrolMaxX } = patrollingSlime
  const floor = map.colliders.find(({ id }) => id === slime.floorId)?.bounds
  if (!floor || position.y !== floor.origin.y || patrolMinX < floor.origin.x || patrolMaxX > floor.origin.x + floor.width)
    throw new Error('Movement smoke Slime patrol must stay on its original floor')
  if (
    map.colliders.some(
      ({ kind, bounds: { origin, width, height } }) =>
        kind === 'solid' &&
        origin.x < patrolMaxX &&
        origin.x + width > patrolMinX &&
        origin.y < position.y &&
        origin.y + height >= position.y
    )
  )
    throw new Error('Movement smoke Slime patrol crosses a solid collider')

  const monsterSpawns = map.monsterSpawns.map((spawn) => (spawn === slime ? patrollingSlime : spawn))
  // 地面追擊受巡邏區間限制。以整個角色寬度驗證移動區離所有怪物的攻擊範圍有間隔。
  for (const spawn of monsterSpawns) {
    const { attackReach } = data.monsters.find(({ id }) => id === spawn.monsterArchetypeId)
    const leftmost = spawn.movement === 'ground' ? spawn.patrolMinX : spawn.flightBounds.origin.x
    if (leftmost - attackReach <= movementSmokeMaxPlayerX + initialPhysicsBalance.bodyWidthWorldUnits)
      throw new Error(`Movement smoke route overlaps ${spawn.id} attack range`)
  }
  return { ...data, tiledMaps: data.tiledMaps.map((entry) => (entry === map ? { ...map, monsterSpawns } : entry)) }
}
