import { toSimulationTick } from '@viesma/domain'
import { loadGrayboxGameData } from '@viesma/game-data'
import { createLocalWorld, createSeededRng, findOverlappingPortal, fixedDeltaSeconds } from '@viesma/simulation'
import { expect, test } from 'vitest'

const data = loadGrayboxGameData()
const forest = data.tiledMaps.find(({ id }) => id === 'm1')
const village = data.tiledMaps.find(({ id }) => id === 'village')
const characterId = 'beginner'
const fullVitals = { hp: 50, maxHp: 50, mp: 30, maxMp: 30 }
const ids = {
  nextAttackId: () => {
    throw new Error('No attack entities')
  },
}

function scenario(gameData = data) {
  const world = createLocalWorld(gameData, characterId)
  const rng = createSeededRng(1)
  let state = world.initialState
  const player = () => state.map.players[0]
  const command = (fields) => ({
    kind: 'input',
    characterId,
    seq: state.tick + 1,
    lifeStartedTick: player().lifeStartedTick,
    mapEpoch: state.mapEpoch,
    moveX: 0,
    jumpPressed: false,
    portalPressed: false,
    ...fields,
  })
  function advance(commands = [], effects = []) {
    const tick = toSimulationTick(state.tick + 1)
    const result = world.advance(state, commands, fixedDeltaSeconds, {
      tick,
      rng,
      ids,
      playerVitalEffects: effects.map((effect, order) => ({
        tick,
        order,
        characterId,
        lifeStartedTick: player().lifeStartedTick,
        ...effect,
      })),
    })
    state = result.state
    return result
  }
  function moveToPortal(map, moveX) {
    for (let i = 0; i < 100; i++) {
      if (findOverlappingPortal(map, player().position)) return
      expect(advance([command({ moveX })]).events).toEqual([])
    }
    throw new Error('Portal not reached by walking')
  }
  const pressUp = () => advance([command({ portalPressed: true })])
  const setPlayer = (fields) => {
    state = { ...state, map: { ...state.map, players: [{ ...player(), ...fields }] } }
  }
  return { state: () => state, player, command, advance, moveToPortal, pressUp, setPlayer }
}

test('walking into a portal and pressing Up outside it do not transfer the player', () => {
  const run = scenario()
  expect(run.pressUp().events).toEqual([])
  run.moveToPortal(village, 1)
  for (let tick = 0; tick < 5; tick++) expect(run.advance([run.command()]).events).toEqual([])
  expect(run.state().map.mapId).toBe('village')
})

test('transfers once per edge, preserves vitals and allows a fresh press inside the return portal', () => {
  const run = scenario()
  run.advance(
    [],
    [
      { kind: 'spendMp', amount: 5 },
      { kind: 'damage', amount: 40 },
    ]
  )
  run.moveToPortal(village, 1)
  const conflict = run.command({ portalPressed: true })
  expect(run.advance([conflict, { ...conflict, portalPressed: false }]).events).toEqual([])
  const before = run.player()
  const entry = run.command({ portalPressed: true })
  expect(run.advance([entry, entry]).events).toEqual([
    expect.objectContaining({
      kind: 'playerTransferred',
      sourceMapId: 'village',
      portalId: 'p_to_m1',
      mapId: 'm1',
      spawnId: 'spawn_from_village',
    }),
  ])
  expect(run.player()).toMatchObject({
    characterId,
    lifeStartedTick: before.lifeStartedTick,
    vitals: { ...fullVitals, mp: 25 },
    position: forest.spawns.find(({ id }) => id === 'spawn_from_village').position,
    spawnProtected: true,
    physics: { grounded: true, velocity: { x: 0, y: 0 } },
    movement: { moveX: 0, lastProcessedInputSeq: null, jumpBufferTicksRemaining: 0, coyoteTicksRemaining: 0 },
    action: { kind: 'none' },
  })
  expect(findOverlappingPortal(forest, run.player().position)).toBeUndefined()
  run.moveToPortal(forest, -1)
  const held = run.command()
  expect(run.advance([held, entry]).events).toEqual([])
  expect(run.advance([run.command({ seq: held.seq, portalPressed: true })]).events).toEqual([])
  expect(run.advance([run.command({ mapEpoch: 0, portalPressed: true })]).events).toEqual([])
  expect(run.state().map.mapId).toBe('m1')
  const returned = run.pressUp()
  expect(returned.events).toEqual([expect.objectContaining({ kind: 'playerTransferred', mapId: 'village', spawnId: 'spawn_from_m1' })])
  expect(run.player().vitals).toEqual({ ...fullVitals, mp: 25 })
  expect(run.state().mapEpoch).toBe(2)
  expect(returned.state.tick - entry.seq).toBeLessThan(30)
})

test('preserves injured HP and spent MP when returning to Village', () => {
  const run = scenario()
  run.moveToPortal(village, 1)
  const entry = run.pressUp()
  run.moveToPortal(forest, -1)
  while (run.state().tick < entry.state.tick + 89) run.advance()
  const damage = run.advance(
    [],
    [
      { kind: 'damage', amount: 7 },
      { kind: 'spendMp', amount: 5 },
    ]
  )
  while (run.state().tick < damage.state.tick + 6) run.advance()
  expect(run.pressUp().state.map.mapId).toBe('village')
  expect(run.player().vitals).toEqual({ ...fullVitals, hp: 43, mp: 25 })
})

test.each(['destination map', 'destination spawn'])('leaves the player in the source when the %s is missing', (missing) => {
  const tiledMaps = missing === 'destination map' ? [village] : [{ ...forest, spawns: [] }, village]
  const run = scenario({ ...data, tiledMaps })
  run.moveToPortal(village, 1)
  const equivalent = scenario({ ...data, tiledMaps })
  equivalent.moveToPortal(village, 1)
  expect(run.pressUp()).toEqual(equivalent.advance([equivalent.command()]))
})

test('entry protection expires at 90 ticks, dead players cannot transfer, and respawn returns to the real hub', () => {
  const run = scenario()
  run.moveToPortal(village, 1)
  const start = run.pressUp().state.tick
  run.moveToPortal(forest, -1)
  const lethal = { kind: 'damage', amount: 50 }
  while (run.state().tick < start + 89) expect(run.advance([], [lethal]).events).toEqual([])
  expect(run.player().vitals.hp).toBe(50)
  const result = run.advance([run.command({ portalPressed: true })], [lethal])
  const [death] = result.events
  expect(death).toMatchObject({ kind: 'playerDied', cause: 'damage' })
  expect(run.state().map.mapId).toBe('m1')
  expect(findOverlappingPortal(forest, run.player().position)).toBeDefined()
  expect(run.pressUp().events).toEqual([])
  while (run.state().tick < death.tick + 89) expect(run.advance().events).toEqual([])
  const respawn = run.pressUp()
  expect(respawn.events).toEqual([
    expect.objectContaining({ kind: 'playerRespawned', deathId: death.deathId, mapId: 'village', spawnId: 'spawn_respawn' }),
  ])
  expect(run.player()).toMatchObject({
    characterId,
    lifeStartedTick: respawn.state.tick,
    position: village.spawns.find(({ id }) => id === 'spawn_respawn').position,
    vitals: fullVitals,
    physics: { grounded: true, velocity: { x: 0, y: 0 } },
    spawnProtected: true,
  })
  expect(run.state().map.monsters).toEqual([])
  expect(run.advance([], [lethal]).events).toEqual([])
})

test('switches collision worlds and deterministically replays a forest fall and hub respawn', () => {
  function replay() {
    const run = scenario()
    run.moveToPortal(village, 1)
    run.pressUp()
    const trace = []
    for (let i = 0; i < 270; i++) trace.push(run.advance([run.command({ moveX: 1 })]))
    return trace
  }
  const trace = replay()
  expect(trace).toEqual(replay())
  expect(trace.flatMap(({ events }) => events)).toMatchObject([
    { kind: 'playerDied', cause: 'void' },
    { kind: 'playerRespawned', mapId: 'village' },
  ])
})

const toggle = { npcInteraction: { kind: 'toggle', npcId: data.guide.npc.id } }

function approachGuide(run) {
  for (let tick = 0; tick < 7; tick++) run.advance([run.command({ moveX: 1 })])
  for (let tick = 0; tick < 7; tick++) run.advance([run.command()])
}

function openGuide(run) {
  approachGuide(run)
  return run.advance([run.command(toggle)])
}

test('requires an explicit Guide edge and accepts the inclusive distance boundary', () => {
  const run = scenario()
  expect(run.advance([run.command(toggle)]).events).toEqual([])
  approachGuide(run)
  expect(run.state().guideInteraction).toBeNull()
  run.setPlayer({ position: { ...run.player().position, x: data.guide.npc.position.x - 96 - 12 } })
  expect(run.pressUp().events).toEqual([])
  const result = run.advance([run.command(toggle)])
  expect(result.events).toEqual([{ kind: 'guideOpened', tick: result.state.tick, characterId, interaction: result.state.guideInteraction }])
  expect(result.state.guideInteraction).toEqual({ mapId: 'village', mapEpoch: 0, npcId: 'npc_guide', openedAtTick: result.state.tick })
})

test.each(['attack', 'hurt', 'death', 'airborne', 'jumping this tick'])('rejects Guide opening while %s', (condition) => {
  const run = scenario()
  approachGuide(run)
  const action = {
    attack: { kind: 'attack', facing: 'right' },
    hurt: { kind: 'hurt', ticksRemaining: 3 },
    death: { kind: 'death', diedAtTick: run.state().tick },
  }[condition]
  if (action) run.setPlayer({ action })
  if (condition === 'airborne') run.setPlayer({ physics: { ...run.player().physics, grounded: false } })
  const result = run.advance([run.command({ ...toggle, jumpPressed: condition === 'jumping this tick' })])
  expect(result.state.guideInteraction).toBeNull()
  expect(result.events).toEqual([])
})

test('rejects stale or malformed commands, unknown NPCs and the Guide ID on a different map', () => {
  const run = scenario()
  approachGuide(run)
  const invalid = [
    { ...toggle, seq: run.player().movement.lastProcessedInputSeq },
    { ...toggle, seq: 1.5 },
    { ...toggle, mapEpoch: 1 },
    { ...toggle, lifeStartedTick: 1 },
    { ...toggle, characterId: 'another_character' },
    { npcInteraction: { kind: 'toggle', npcId: 5 } },
    { npcInteraction: { kind: 'toggle', npcId: 'unknown_npc' } },
    { npcInteraction: { ...toggle.npcInteraction, position: data.guide.npc.position } },
  ]
  for (const fields of invalid) {
    const result = run.advance([run.command(fields)])
    expect(result.events).toEqual([])
    expect(result.state.guideInteraction).toBeNull()
  }
  run.moveToPortal(village, 1)
  expect(run.pressUp().state.map.mapId).toBe('m1')
  expect(run.advance([run.command(toggle)]).events).toEqual([])
  expect(run.state().guideInteraction).toBeNull()
})

test('deduplicates open and close, rejects conflicting seqs and scopes the close button to its dialogue', () => {
  const run = scenario()
  approachGuide(run)
  const conflict = run.command(toggle)
  expect(run.advance([conflict, run.command()]).events).toEqual([])
  const open = run.command(toggle)
  expect(run.advance([open, open]).events.map(({ kind }) => kind)).toEqual(['guideOpened'])
  const first = run.state().guideInteraction
  expect(run.advance([open]).events).toEqual([])
  expect(run.state().guideInteraction).toBe(first)
  expect(run.advance([run.command(toggle)]).events).toMatchObject([{ kind: 'guideClosed', reason: 'requested' }])
  run.advance([run.command(toggle)])
  const close = (interaction) =>
    run.command({ npcInteraction: { kind: 'close', npcId: interaction.npcId, openedAtTick: interaction.openedAtTick } })
  expect(run.advance([close(first)]).events).toEqual([])
  const closeCurrent = close(run.state().guideInteraction)
  expect(run.advance([closeCurrent, closeCurrent]).events).toMatchObject([{ kind: 'guideClosed', reason: 'requested' }])
  expect(run.advance([closeCurrent]).events).toEqual([])
  expect(run.state().guideInteraction).toBeNull()
})

test('closes once when walking out of range and deterministically replays the Guide trace', () => {
  function replay() {
    const run = scenario()
    const trace = [openGuide(run)]
    for (let tick = 0; tick < 35; tick++) trace.push(run.advance([run.command({ moveX: -1 })]))
    expect(run.state().guideInteraction).toBeNull()
    return trace
  }
  const trace = replay()
  expect(trace).toEqual(replay())
  expect(trace.flatMap(({ events }) => events)).toMatchObject([{ kind: 'guideOpened' }, { kind: 'guideClosed', reason: 'outOfRange' }])
})

test('interrupts an open Guide interaction once when void death occurs', () => {
  const run = scenario()
  expect(openGuide(run).events).toMatchObject([{ kind: 'guideOpened' }])
  // 正式 Village 有連續地板。用測試位置注入 void，走同一個死亡步進。
  run.setPlayer({ position: { x: run.player().position.x, y: village.bounds.height + 2048 } })
  const result = run.advance([run.command(toggle)])
  expect(result.events).toMatchObject([
    { kind: 'playerDied', cause: 'void' },
    { kind: 'guideClosed', reason: 'death' },
  ])
  expect(result.state.guideInteraction).toBeNull()
  expect(run.advance([run.command(toggle)]).events).toEqual([])
})

test('uses portal rules independently and closes an open dialogue on a successful transfer', () => {
  const gate = village.portals.find(({ id }) => id === 'p_to_m1')
  const npc = { ...data.guide.npc, position: { x: gate.bounds.origin.x + gate.bounds.width / 2, y: data.guide.npc.position.y } }
  const run = scenario({
    ...data,
    guide: { ...data.guide, npc },
    tiledMaps: data.tiledMaps.map((map) => (map === village ? { ...map, npcs: [npc] } : map)),
  })
  run.moveToPortal(village, 1)
  const opened = run.advance([run.command(toggle)])
  expect(opened.state.map.mapId).toBe('village')
  expect(opened.events).toMatchObject([{ kind: 'guideOpened' }])
  const transfer = run.advance([run.command({ ...toggle, portalPressed: true })])
  expect(transfer.events).toMatchObject([
    { kind: 'playerTransferred', portalId: gate.id, mapId: 'm1' },
    { kind: 'guideClosed', reason: 'mapChanged' },
  ])
  expect(transfer.state.guideInteraction).toBeNull()
  expect(transfer.state.mapEpoch).toBe(1)
})
