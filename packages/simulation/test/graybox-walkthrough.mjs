import { toSimulationTick } from '@viesma/domain'
import { initialPhysicsBalance, loadGrayboxGameData } from '@viesma/game-data'
import { createLocalWorld, createPlayer, createSeededRng, findOverlappingPortal, fixedDeltaSeconds } from '@viesma/simulation'

export const graybox = loadGrayboxGameData()
export const mapById = new Map(graybox.tiledMaps.map((map) => [map.id, map]))
export const characterId = 'graybox-beginner'
export const bodySize = { width: initialPhysicsBalance.bodyWidthWorldUnits, height: initialPhysicsBalance.bodyHeightWorldUnits }
export const hubSpawn = graybox.world.respawn
const world = createLocalWorld(graybox, characterId)
const ids = {
  nextAttackId() {
    throw new Error('Graybox walkthrough does not create attacks')
  },
}

// 每個岸邊的起跳標記給 Beginner 足夠助跑距離。M1 中途落在較高的單向橋面。
const gaps = {
  m1: { landLeft: 1248, landRight: 1432, takeoffRight: 1190, takeoffLeft: 1490 },
  m6: { landLeft: 2664, landRight: 2768, takeoffRight: 2628, takeoffLeft: 2800 },
}

export function createWalkthrough(start = hubSpawn) {
  const rng = createSeededRng(1)
  const spawn = mapById.get(start.mapId).spawns.find(({ id }) => id === start.spawnId)
  let state =
    start === hubSpawn
      ? world.initialState
      : {
          ...world.initialState,
          map: {
            ...world.initialState.map,
            mapId: start.mapId,
            mapInstanceId: 'local:' + start.mapId,
            players: [createPlayer(characterId, spawn.position, true, spawn.facing)],
          },
        }
  const trace = []
  const player = () => state.map.players[0]
  const feetX = () => player().position.x + bodySize.width / 2
  const feetY = () => player().position.y + bodySize.height
  const map = () => mapById.get(state.map.mapId)
  const command = (fields = {}) => ({
    kind: 'input',
    characterId,
    seq: state.tick + 1,
    mapEpoch: state.mapEpoch,
    lifeStartedTick: player().lifeStartedTick,
    moveX: 0,
    jumpPressed: false,
    portalPressed: false,
    ...fields,
  })

  function advance(fields, { commands = [command(fields)], effects = [] } = {}) {
    const tick = toSimulationTick(state.tick + 1)
    const result = world.advance(state, commands, fixedDeltaSeconds, {
      rng,
      ids,
      tick,
      playerVitalEffects: effects.map((effect, order) => ({
        tick,
        order,
        characterId,
        lifeStartedTick: player().lifeStartedTick,
        ...effect,
      })),
    })
    state = result.state
    trace.push({ ...result, input: fields ?? {} })
    return result
  }

  function moveUntil(targetX, moveX) {
    for (let count = 0; moveX * (targetX - feetX()) > 0; count++) {
      const event = advance({ moveX }).events[0]
      if (count >= 900 || event) throw new Error(`Could not reach x=${targetX} from ${map().id}: ${event?.kind ?? feetX()}`)
    }
  }

  function settle() {
    for (let count = 0; count < 30; count++) {
      if (player().physics.grounded && player().physics.velocity.x === 0) return
      if (advance().events.length) break
    }
    throw new Error(`Could not stop on a surface at ${map().id} (${feetX()}, ${feetY()})`)
  }

  function walkTo(targetX) {
    const moveX = Math.sign(targetX - feetX())
    const gap = gaps[map().id]
    if (gap && ((feetX() < gap.landLeft && targetX > gap.landRight) || (feetX() > gap.landRight && targetX < gap.landLeft))) {
      moveUntil(moveX === 1 ? gap.takeoffRight : gap.takeoffLeft, moveX)
      advance({ moveX, jumpPressed: true })
    }
    moveUntil(targetX, moveX)
    settle()
  }

  function hop(moveX = 0) {
    if (!player().physics.grounded) throw new Error('Jump must start from support')
    advance({ moveX, jumpPressed: true })
    for (let count = 0; count < 40; count++) {
      if (player().physics.grounded) return
      if (advance({ moveX }).events.length) break
    }
    throw new Error(`Jump did not land at ${map().id} (${feetX()}, ${feetY()})`)
  }

  function approach(portalId) {
    const portal = map().portals.find(({ id }) => id === portalId)
    walkTo(portal.bounds.origin.x + portal.bounds.width / 2)
    if (findOverlappingPortal(map(), player().position) !== portal) {
      throw new Error(`Could not reach ${map().id}/${portalId} on the ground from ${start.spawnId}`)
    }
    return portal
  }

  return { state: () => state, player, map, feetX, feetY, command, advance, trace, walkTo, hop, settle, approach }
}

export const tourDestinations = ['m1', 'm5', 'm1', 'village', 'm2', 'm6', 'm2', 'village', 'm3', 'village', 'm4', 'village']

export function planGrayboxTour() {
  const run = createWalkthrough()
  return tourDestinations.map((destination) => {
    const startIndex = run.trace.length
    const portal = run.approach('p_to_' + destination)
    const approachInputs = run.trace.slice(startIndex).map(({ input }) => input)
    run.advance({ portalPressed: true })
    if (run.map().id !== destination) throw new Error(`Transfer to ${destination} failed`)
    return { portal, approachInputs, map: run.map(), arrival: run.player().position }
  })
}
