import { sharedCombatData } from './shared-combat-fixture.mjs'

export function progressionTestData() {
  const data = sharedCombatData()
  return {
    ...data,
    monsters: data.monsters.map((monster) => (monster.id === 'slime' ? { ...monster, baseHp: 20, baseExp: 100, attackReach: 8 } : monster)),
    tiledMaps: data.tiledMaps.map((map) =>
      map.id === 'm1'
        ? {
            ...map,
            monsterSpawns: map.monsterSpawns.filter(({ id }) => id === 'spawn_slime_1').map((spawn) => ({ ...spawn, level: 1 })),
            portals: map.portals.map((portal) =>
              portal.id === 'p_to_village' ? { ...portal, bounds: { ...portal.bounds, origin: { x: 411, y: 848 } } } : portal
            ),
          }
        : map
    ),
  }
}
