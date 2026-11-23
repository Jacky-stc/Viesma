import { createInitialGameDataSource } from './fixture.js'
import { loadGuideDefinition } from './guide.js'
import { loadGameData } from './load.js'
import m1 from './maps/m1.json' with { type: 'json' }
import m2 from './maps/m2.json' with { type: 'json' }
import m3 from './maps/m3.json' with { type: 'json' }
import m4 from './maps/m4.json' with { type: 'json' }
import m5 from './maps/m5.json' with { type: 'json' }
import m6 from './maps/m6.json' with { type: 'json' }
import village from './maps/village.json' with { type: 'json' }
import { invalid } from './validation.js'

const bundledExports = Object.entries({ village, m1, m2, m3, m4, m5, m6 }).map(([mapId, map]) => ({ mapId, map, tilesets: {} }))

export function loadGrayboxGameData(tiledExports: unknown = bundledExports) {
  const data = loadGameData(createInitialGameDataSource(), tiledExports)
  const maps = new Map(data.tiledMaps.map((map) => [map.id, map]))
  for (const { id, monsterGroups } of data.world.maps) {
    const map = maps.get(id)
    if (!map) invalid('MISSING_FIELD', 'tiledMaps', `Missing graybox map "${id}"`)
    // 通用匯入器已核對各組的等級與數量上限，總數相符即可確認每組完整。
    const expectedSpawns = monsterGroups.reduce((total, { count }) => total + count, 0)
    if (map.monsterSpawns.length !== expectedSpawns) {
      invalid('MISSING_FIELD', 'tiledMaps', `Expected ${expectedSpawns} MonsterSpawn objects on "${id}"`)
    }
  }
  return Object.freeze({ ...data, guide: loadGuideDefinition(maps) })
}
