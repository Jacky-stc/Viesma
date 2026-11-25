import { loadGrayboxGameData } from '@viesma/game-data'
import { PROTOCOL_VERSION } from '@viesma/protocol'

export function sharedCombatData() {
  const data = loadGrayboxGameData()
  const tiledMaps = data.tiledMaps.map((map) => {
    if (map.id === 'm1') {
      return {
        ...map,
        spawns: map.spawns.map((spawn) => (spawn.id === 'spawn_from_village' ? { ...spawn, position: { x: 411, y: 848 } } : spawn)),
        monsterSpawns: map.monsterSpawns.map((spawn) =>
          spawn.id === 'spawn_slime_1' ? { ...spawn, patrolMinX: 460, patrolMaxX: 470 } : spawn
        ),
      }
    }
    if (map.id === 'village') {
      const respawn = map.spawns.find(({ id }) => id === 'spawn_respawn')
      return {
        ...map,
        portals: map.portals.map((portal) =>
          portal.id === 'p_to_m1' ? { ...portal, bounds: { ...portal.bounds, origin: respawn.position } } : portal
        ),
      }
    }
    return map
  })
  return { ...data, tiledMaps }
}

export function combatPeer() {
  return {
    connection: {},
    session: undefined,
    offers: [],
    failures: [],
    closes: 0,
    seq: 0,
    joined(session) {
      this.session = session
    },
    offer(offer) {
      this.offers.push(offer)
    },
    failed(failure) {
      this.failures.push(failure)
    },
    close() {
      this.closes++
    },
  }
}

export function combatInput(peer, fields) {
  const { connectionEpoch, mapEpoch } = peer.session
  return {
    protocolVersion: PROTOCOL_VERSION,
    connectionEpoch,
    mapEpoch,
    seq: peer.seq + 1,
    moveX: 0,
    jumpPressed: false,
    attackPressed: false,
    ...fields,
  }
}

export function sendCombatInput(world, room, peer, fields) {
  const input = combatInput(peer, fields)
  if (!world.receive(room, peer.connection, input)) return false
  peer.seq = input.seq
  return true
}

export function entrySlime(room) {
  return room.snapshot().monsters.find(({ archetypeId, x, y }) => archetypeId === 'slime' && y === 896 && x >= 460 && x <= 470)
}
