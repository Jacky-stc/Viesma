import { initialPlayerLifecycleBalance } from '@viesma/game-data'
import { findOverlappingPortal } from '@viesma/simulation'
import { expect, test } from 'vitest'
import { bodySize, createWalkthrough, graybox, hubSpawn, mapById, tourDestinations } from './graybox-walkthrough.mjs'

const spawnRoutes = graybox.tiledMaps.flatMap(({ id: mapId, spawns, portals }) =>
  spawns.flatMap(({ id: spawnId }) => portals.map(({ id: portalId }) => ({ mapId, spawnId, portalId })))
)

test.each(spawnRoutes)('$mapId/$spawnId can physically reach $portalId and transfer with normal input', ({ mapId, spawnId, portalId }) => {
  const run = createWalkthrough({ mapId, spawnId })
  const before = run.advance()
  expect(before.state.map.players[0].position).toEqual(mapById.get(mapId).spawns.find(({ id }) => id === spawnId).position)
  const portal = run.approach(portalId)
  expect(run.trace.flatMap(({ events }) => events)).toEqual([])
  expect(run.player().physics.grounded).toBe(true)
  expect(findOverlappingPortal(run.map(), run.player().position)?.id).toBe(portal.id)
  const entry = run.command({ portalPressed: true })
  const result = run.advance({}, { commands: [entry, entry] })
  expect(result.state.mapEpoch).toBe(1)
  expect(result.state.map.players).toHaveLength(1)
  expect(result.events).toMatchObject([
    {
      kind: 'playerTransferred',
      sourceMapId: mapId,
      portalId,
      mapId: portal.destinationMapId,
      spawnId: portal.destinationSpawnId,
    },
  ])
  const spawn = run.map().spawns.find(({ id }) => id === portal.destinationSpawnId)
  expect(run.player()).toMatchObject({
    position: spawn.position,
    facing: spawn.facing,
    physics: { grounded: true, inVoid: false, velocity: { x: 0, y: 0 } },
    movement: { moveX: 0, lastProcessedInputSeq: null },
    action: { kind: 'none' },
  })
  expect(findOverlappingPortal(run.map(), run.player().position)).toBeUndefined()
  run.advance({}, { commands: [{ ...entry, seq: entry.seq + 1, moveX: 1, jumpPressed: true }] })
  expect(run.player().position).toEqual(spawn.position)
  expect(run.player().movement.lastProcessedInputSeq).toBeNull()
})

test('visits every map and returns to Village in a deterministic 12-transfer replay', () => {
  function replay() {
    const run = createWalkthrough()
    for (const destination of tourDestinations) {
      const start = run.trace.length
      run.approach('p_to_' + destination)
      if (run.map().id === 'm1' && run.trace.slice(start).some(({ input }) => input.jumpPressed)) {
        const { bounds } = run.map().colliders.find(({ id }) => id === 'forest_crossing')
        expect(
          run.trace.slice(start).some(
            ({
              state: {
                map: {
                  players: [player],
                },
              },
            }) =>
              player.physics.grounded &&
              player.position.y + bodySize.height === bounds.origin.y &&
              player.position.x < bounds.origin.x + bounds.width &&
              player.position.x + bodySize.width > bounds.origin.x
          )
        ).toBe(true)
      }
      run.advance({ portalPressed: true })
    }
    return run.trace
  }
  const trace = replay()
  expect(trace).toEqual(replay())
  const transfers = trace.flatMap(({ events }) => events)
  expect(transfers.map(({ mapId }) => mapId)).toEqual(tourDestinations)
  expect(new Set(transfers.map(({ mapId }) => mapId))).toEqual(new Set(mapById.keys()))
  expect(new Set(transfers.map(({ sourceMapId, portalId }) => sourceMapId + '/' + portalId)).size).toBe(12)
  expect(trace.at(-1).state).toMatchObject({ mapEpoch: 12, map: { mapId: 'village' } })
})

// 每列都是從一個已驗證的地面出生點走跳到指定踏面。後續段落由上一個平台接續。
const platformRoutes = {
  m2: [
    [[700, 0, 'plains_west_platform']],
    [
      [1188, 1, 'plains_west_deck'],
      [1480, 0, 'plains_west_overlook'],
    ],
    [[2350, 0, 'plains_mid_platform']],
    [
      [3212, 1, 'plains_east_deck'],
      [3480, 0, 'plains_east_overlook'],
    ],
  ],
  m3: [
    [
      [588, 1, 'hills_first_ledge'],
      [972, 0, 'hills_middle_step'],
      [1212, 1, 'hills_crown'],
      [1500, 0, 'hills_ridge'],
    ],
    [[2400, 0, 'hills_outcrop']],
  ],
  m4: [
    [
      [748, 1, 'cave_step'],
      [952, 0, 'cave_middle'],
    ],
    [[1500, 0, 'cave_niche']],
    [
      [2898, 1, 'cave_gallery'],
      [3144, 0, 'cave_far_niche'],
    ],
  ],
  m5: [
    [
      [588, 1, 'deep_root_deck'],
      [982, 0, 'deep_west_branch'],
      [1238, 0, 'deep_mid_branch'],
      [1507, 0, 'deep_high_branch'],
      [1760, 0, 'deep_canopy'],
    ],
    [
      [1680, 0, 'deep_east_branch'],
      [1705, 1, 'deep_east_deck'],
    ],
    [
      [2510, 0, 'deep_low_shelf'],
      [2690, 0, 'deep_mid_shelf'],
      [2970, 0, 'deep_high_shelf'],
    ],
  ],
  m6: [
    [
      [568, 1, 'ruins_terrace'],
      [1020, 0, 'ruins_mid_stair'],
      [1188, 1, 'ruins_upper_terrace'],
      [1492, 0, 'ruins_balcony'],
    ],
    [
      [3218, 1, 'ruins_altar'],
      [3542, 0, 'ruins_column_ledge'],
    ],
  ],
}

for (const [mapId, routes] of Object.entries(platformRoutes)) {
  test(`${mapId} can land on every authored platform from the entry floor`, () => {
    const landed = new Set()
    for (const route of routes) {
      const run = createWalkthrough({
        mapId,
        spawnId: mapId === 'm5' ? 'spawn_from_m1' : mapId === 'm6' ? 'spawn_from_m2' : 'spawn_from_village',
      })
      for (const [takeoffX, moveX, colliderId] of route) {
        run.walkTo(takeoffX)
        run.hop(moveX)
        const { origin, width } = run.map().colliders.find(({ id }) => id === colliderId).bounds
        expect(run.feetY(), colliderId).toBe(origin.y)
        expect(run.feetX(), colliderId).toBeGreaterThan(origin.x - bodySize.width / 2)
        expect(run.feetX(), colliderId).toBeLessThan(origin.x + width + bodySize.width / 2)
        landed.add(colliderId)
        run.settle()
      }
      expect(run.trace.flatMap(({ events }) => events)).toEqual([])
    }
    const expected = mapById.get(mapId).colliders.filter(({ bounds }) => bounds.height <= 24)
    expect(landed).toEqual(new Set(expected.map(({ id }) => id)))
  })
}

const fields = [...mapById.keys()].filter((id) => id !== 'village')

test('Up does not transfer during takeoff or while airborne inside a field portal', () => {
  const run = createWalkthrough({ mapId: 'm4', spawnId: 'spawn_from_village' })
  run.approach('p_to_village')
  expect(run.advance({ jumpPressed: true, portalPressed: true }).events).toEqual([])
  expect(run.player().physics.grounded).toBe(false)
  expect(findOverlappingPortal(run.map(), run.player().position)?.id).toBe('p_to_village')
  expect(run.advance({ portalPressed: true }).events).toEqual([])
  run.settle()
  expect(run.advance({ portalPressed: true }).events).toMatchObject([{ kind: 'playerTransferred', mapId: 'village' }])
})

test.each(fields)('damage in %s returns the same player to a safe Village spawn after 90 ticks', (mapId) => {
  const spawnId = mapById.get(mapId).spawns[0].id
  const run = createWalkthrough({ mapId, spawnId })
  const before = run.player()
  const stale = run.command({ seq: 999, jumpPressed: true, moveX: 1, portalPressed: true })
  const {
    events: [death],
  } = run.advance(
    {},
    {
      effects: [
        { kind: 'spendMp', amount: 5 },
        { kind: 'damage', amount: before.vitals.hp },
      ],
    }
  )
  expect(death).toMatchObject({ kind: 'playerDied', cause: 'damage' })
  expect(run.player().vitals).toMatchObject({ hp: 0, mp: 25 })
  for (let ticks = 1; ticks < initialPlayerLifecycleBalance.respawnDelayTicks; ticks++) expect(run.advance().events).toEqual([])
  const result = run.advance({}, { commands: [stale] })
  expect(result.state.tick - death.tick).toBe(initialPlayerLifecycleBalance.respawnDelayTicks)
  expect(result.events).toMatchObject([{ kind: 'playerRespawned', deathId: death.deathId, ...hubSpawn }])
  expect(result.state.mapEpoch).toBe(1)
  const spawn = run.map().spawns.find(({ id }) => id === hubSpawn.spawnId)
  expect(run.player()).toMatchObject({
    characterId: before.characterId,
    position: spawn.position,
    vitals: before.vitals,
    physics: { grounded: true, inVoid: false, velocity: { x: 0, y: 0 } },
  })
  run.advance({}, { commands: [stale], effects: [{ kind: 'damage', amount: before.vitals.hp }] })
  expect(run.player().position).toEqual(spawn.position)
  expect(run.player().vitals).toEqual(before.vitals)
})

test('walking into the ruins gap falls into the void and returns to Village without a second player', () => {
  const run = createWalkthrough({ mapId: 'm6', spawnId: 'spawn_from_m2' })
  run.walkTo(2580)
  for (let count = 0; count < 150 && run.map().id === 'm6'; count++) run.advance({ moveX: 1 })
  expect(run.trace.flatMap(({ events }) => events)).toMatchObject([
    { kind: 'playerDied', cause: 'void' },
    { kind: 'playerRespawned', ...hubSpawn },
  ])
  expect(run.state().map.players).toHaveLength(1)
})

test('can jump over the ruins gap in both directions using the normal run-up', () => {
  const run = createWalkthrough({ mapId: 'm6', spawnId: 'spawn_from_m2' })
  run.walkTo(3000)
  expect(run.feetX()).toBeGreaterThan(2768)
  run.walkTo(2448)
  expect(run.feetX()).toBeLessThan(2664)
  expect(run.player().physics.grounded).toBe(true)
  expect(run.trace.flatMap(({ events }) => events)).toEqual([])
})
