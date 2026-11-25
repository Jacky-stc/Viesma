import { initialPhysicsBalance } from '@viesma/game-data'
import { expect, test } from 'vitest'
import { applyEncounterHit } from '../src/encounter-rewards.ts'
import { createPlayer, createSeededRng, fixedDeltaSeconds, spawnMonsters, step } from '../src/index.ts'

const origin = { x: 1000, y: 600 }
const centerY = origin.y - 12
const { bodyWidthWorldUnits: width, bodyHeightWorldUnits: height } = initialPhysicsBalance

function body(characterId, dx = 0) {
  return createPlayer(characterId, { x: origin.x + dx - width / 2, y: centerY - height / 2 }, true)
}

function spawn(maxHp = 200) {
  return spawnMonsters(
    [
      {
        spawnId: 'spawn-fixture',
        archetypeId: 'slime',
        origin,
        bounds: { min: origin, max: { x: 1200, y: 600 } },
        movement: 'ground',
        maxHp,
        patrolSpeed: 60,
        chaseSpeed: 100,
        attackReach: 36,
        attack: 6,
        defense: 1,
        damageType: 'physical',
      },
    ],
    1,
    { nextMonsterId: () => 'monster', nextEncounterId: () => 'initial' },
    createSeededRng(3)
  )[0]
}

function harness(characters, maxHp) {
  let monster = { ...spawn(maxHp), behavior: { kind: 'patrol' } }
  let nextAttack = 0
  const members = new Map()
  const disconnected = new Set()
  const context = {
    mapId: 'm1',
    mapInstanceId: 'room-1',
    balanceVersion: 'mvp-1',
    tick: 1,
    players: characters.map((id) => body(id)),
    participant: (id) => ({ connected: !disconnected.has(id), membership: members.get(id) }),
  }
  function hitEvent(characterId, damage, tick) {
    const effectiveDamage = Math.min(damage, monster.hp)
    return {
      kind: 'monsterDamaged',
      mapInstanceId: context.mapInstanceId,
      monsterId: monster.monsterId,
      encounterId: monster.encounterId,
      attackId: `swing-${++nextAttack}`,
      characterId,
      tick,
      damage,
      effectiveDamage,
      lethal: effectiveDamage === monster.hp,
      critical: false,
    }
  }
  return {
    context,
    members,
    disconnected,
    get monster() {
      return monster
    },
    hitEvent,
    hit(characterId, amount, tick) {
      context.tick = tick
      const applied = applyEncounterHit(monster, hitEvent(characterId, amount, tick), context)
      expect(applied).toBeDefined()
      monster = applied.monster
      return applied.intent
    },
  }
}

function party(partyId, membershipToken) {
  return { kind: 'party', partyId, membershipToken }
}

test('locks first positive damage and freezes all groups in bytewise order even when tied or disbanded', () => {
  const h = harness(['a', 'b', 'c', 'd', 'e', 'idle'], 100)
  const bMembership = party('Z', 'old-b')
  h.members.set('b', bMembership)
  h.members.set('c', party('Z', 'old-c'))
  h.members.set('d', party('a', 'old-d'))
  h.members.set('e', party('a', 'old-e'))
  h.hit('a', 10, 1)
  h.hit('b', 20, 2)
  h.hit('c', 20, 3)
  h.hit('d', 20, 4)
  h.members.set('a', party('Z', 'new-a'))
  bMembership.membershipToken = 'new-b'
  h.members.delete('d')
  h.hit('a', 10, 5)
  const intent = h.hit('e', 99, 6)
  expect(intent.groups).toMatchObject([
    {
      groupKey: 'party:Z',
      effectiveDamage: 40,
      eligibleCharacterIds: ['c'],
      contributions: [{ characterId: 'b', lockedGroup: { membershipToken: 'old-b' } }, { characterId: 'c' }],
    },
    {
      groupKey: 'party:a',
      effectiveDamage: 40,
      eligibleCharacterIds: ['e'],
      contributions: [{ characterId: 'd' }, { characterId: 'e', lastDamageTick: 6, effectiveDamage: 20 }],
    },
    { groupKey: 'solo:a', effectiveDamage: 20, eligibleCharacterIds: ['a'] },
  ])
  h.members.clear()
  h.disconnected.add('a')
  expect(intent.groups.map(({ eligibleCharacterIds }) => eligibleCharacterIds)).toEqual([['c'], ['e'], ['a']])
  expect(Object.isFrozen(intent)).toBe(true)
  expect(Object.isFrozen(intent.claim.position)).toBe(true)
  expect(Object.isFrozen(intent.groups[0].contributions[0].lockedGroup)).toBe(true)
  expect(() => intent.groups[2].eligibleCharacterIds.push('idle')).toThrow(TypeError)
})

test('keeps damage but no eligible members after disband or a move to another party', () => {
  const h = harness(['left', 'changed', 'lethal'], 60)
  h.members.set('left', party('old', 'token-left'))
  h.members.set('changed', party('old', 'token-changed'))
  h.hit('left', 20, 1)
  h.hit('changed', 20, 2)
  h.members.delete('left')
  h.members.set('changed', party('new', 'token-new'))
  expect(h.hit('lethal', 20, 3).groups).toMatchObject([
    { groupKey: 'party:old', effectiveDamage: 40, eligibleCharacterIds: [] },
    { groupKey: 'solo:lethal', effectiveDamage: 20, eligibleCharacterIds: ['lethal'] },
  ])
})

test('includes inclusive contribution, time and distance boundaries and excludes unavailable bodies', () => {
  const names = ['exact', 'low', 'late', 'far', 'dead', 'dropped', 'gone', 'transferred', 'rebound', 'lethal']
  const h = harness(names, 101)
  h.hit('late', 2, 1)
  for (const id of names.slice(0, -1).filter((id) => id !== 'late')) h.hit(id, id === 'low' ? 1 : 2, 2)
  const dead = body('dead')
  h.context.players = [
    body('exact', 640),
    body('low'),
    body('late'),
    body('far', 640 + 1 / 1024),
    { ...dead, vitals: { ...dead.vitals, hp: 0 }, action: { kind: 'death', diedAtTick: 3 } },
    body('dropped'),
    body('rebound'),
    body('lethal'),
  ]
  h.disconnected.add('dropped')
  h.disconnected.add('rebound')
  h.disconnected.delete('rebound')
  const { groups } = h.hit('lethal', 200, 452)
  expect(groups.flatMap(({ eligibleCharacterIds }) => eligibleCharacterIds)).toEqual(['exact', 'lethal', 'rebound'])
  expect(groups.reduce((sum, { effectiveDamage }) => sum + effectiveDamage, 0)).toBe(101)
  expect(groups).toHaveLength(names.length)
})

test('rejects duplicate, stale, cross-instance and invalid hits before modifying HP or finalizing a claim', () => {
  const h = harness(['a'], 60)
  const initialHit = h.hitEvent('a', 20, 1)
  const applied = applyEncounterHit(h.monster, initialHit, h.context)
  expect(applied).toMatchObject({ monster: { hp: 40 } })
  const duplicate = applyEncounterHit(applied.monster, initialHit, h.context)
  expect(duplicate).toBeUndefined()
  for (const invalid of [
    { mapInstanceId: 'room-2' },
    { monsterId: 'other-monster' },
    { encounterId: 'stale' },
    { tick: 0 },
    { characterId: 'missing' },
    { attackId: '' },
    { damage: NaN },
    { effectiveDamage: 0 },
    { effectiveDamage: 19 },
    { effectiveDamage: 20.1 },
    { effectiveDamage: 61 },
    { lethal: true },
  ]) {
    expect(applyEncounterHit(h.monster, { ...initialHit, ...invalid }, h.context)).toBeUndefined()
  }
  const intent = h.hit('a', 60, 1)
  expect(applyEncounterHit(h.monster, initialHit, h.context)).toBeUndefined()
  expect(intent.claim).toMatchObject({ mapInstanceId: 'room-1', monsterId: 'monster', encounterId: 'initial' })
  const anotherRoom = harness(['a'], 60)
  anotherRoom.context.mapInstanceId = 'room-2'
  expect(anotherRoom.hit('a', 60, 1).claim.deathId).not.toBe(intent.claim.deathId)
})

test('Return ignores hits, clears the ledger at spawn and rejects stale events for the unchanged monsterId', () => {
  const h = harness(['a'], 60)
  h.hit('a', 20, 1)
  const returning = { ...h.monster, behavior: { kind: 'return' } }
  const event = h.hitEvent('a', 20, 1)
  expect(applyEncounterHit(returning, event, h.context)).toBeUndefined()
  const state = { tick: 1, map: { mapId: 'm1', mapInstanceId: 'room-1', players: [], monsters: [returning], attacks: [] } }
  const context = {
    tick: 2,
    rng: createSeededRng(3),
    ids: { nextAttackId: () => 'unused' },
    monsters: { move: (_, destination) => destination, nextMonsterId: () => 'unused', nextEncounterId: () => 'fresh' },
  }
  const result = step(state, [], fixedDeltaSeconds, context)
  const [reset] = result.state.map.monsters
  expect(result.events).toEqual([])
  expect(reset).toMatchObject({ monsterId: 'monster', encounterId: 'fresh', ledger: null, hp: 60 })
  h.context.tick = 3
  expect(applyEncounterHit(reset, { ...event, tick: 3 }, h.context)).toBeUndefined()
  const fresh = applyEncounterHit(reset, { ...event, tick: 3, encounterId: 'fresh' }, h.context)
  expect(fresh.monster.ledger.contributors.get('a').effectiveDamage).toBe(20)
})
