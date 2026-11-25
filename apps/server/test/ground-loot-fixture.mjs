import { playerFeet } from '@viesma/simulation'

export function fixtureGroundGrant(room, characterId, content, { label = 'drop', position, expiresAt = 120_000 } = {}) {
  return {
    state: 'committed',
    lootId: `loot:${JSON.stringify([room.mapInstanceId, characterId, label])}`,
    deathId: `fixture-death:${label}`,
    ownerCharacterId: characterId,
    tableEntryId: label,
    balanceVersion: 'fixture',
    mapId: room.map.id,
    placement: {
      kind: 'pending',
      sourceMapInstanceId: room.mapInstanceId,
      deathPosition: position ?? playerFeet(room.player(characterId)),
    },
    content,
    expiresAtUtcMilliseconds: expiresAt,
  }
}
