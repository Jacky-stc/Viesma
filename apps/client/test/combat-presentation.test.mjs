import { maxCombatDamageEvents, parseCombatDamageBatch } from '@viesma/protocol'
import { expect, test } from 'vitest'
import { createCombatPresentation } from '../src/multiplayer/combat-presentation.ts'

const batch = (serverTick, events, mapInstanceId = 'room') => ({ mapInstanceId, serverTick, events })
const hit = (id, tick, extra = {}) => ({
  id,
  tick,
  targetId: 'old-monster',
  kind: 'monster',
  generation: 1,
  x: 50,
  y: 70,
  amount: 20,
  critical: false,
  ...extra,
})
const monster = (monsterId = 'old-monster', generation = 1, state = 'patrol') => ({ monsterId, generation, state })
const player = (mapEpoch = 0, lifeStartedTick = 0) => ({ characterId: 'hero', mapEpoch, lifeStartedTick })

test('plays an authoritative damage number once, expires it and skips history on a new connection', () => {
  const view = createCombatPresentation()
  view.snapshot('room', 10, [], [monster()])
  view.receive(batch(10, [hit(1, 10)]), 100)
  expect(view.sample(100)).toEqual([])
  view.snapshot('room', 13, [], [monster()])
  const next = batch(13, [hit(2, 12)])
  view.receive(next, 200)
  view.receive(next, 201)
  expect(view.sample(600)).toEqual([{ ...hit(2, 12), progress: 0.5 }])
  expect(view.receivedCount()).toBe(1)
  expect(view.sample(1000)).toEqual([])
  view.clear()
  view.snapshot('room', 15, [], [monster('old-monster', 1, 'dead')])
  view.receive(batch(15, [hit(2, 12)]), 1100)
  expect(view.sample(1100)).toEqual([])
  expect(view.receivedCount()).toBe(0)
})

test('drops old snapshots and damage after a generation, life or map change', () => {
  const view = createCombatPresentation()
  const playerHit = hit(2, 2, { targetId: 'hero', kind: 'player', lifeStartedTick: 0, mapEpoch: 0 })
  view.snapshot('room', 1, [player()], [monster()])
  view.snapshot('room', 2, [player()], [monster('old-monster', 1, 'dead')])
  view.receive(batch(2, [hit(1, 2), playerHit]), 100)
  expect(view.sample(100).map(({ id }) => id)).toEqual([1, 2])
  view.snapshot('room', 3, [player(1, 3)], [monster('new-monster', 2, 'spawning')])
  view.snapshot('room', 2, [player()], [monster()])
  view.receive(batch(2, [hit(3, 2)]), 110)
  view.receive(batch(3, [hit(3, 3), { ...playerHit, id: 4, tick: 3 }]), 110)
  view.receive(batch(3, [hit(5, 3, { targetId: 'new-monster', generation: 2 })], 'other-room'), 110)
  expect(view.sample(110)).toEqual([])
  view.clear()
  view.snapshot('other-room', 4, [], [])
  expect(view.sample(120)).toEqual([])
})

test('rejects malformed, oversized, unsorted and expired wire events', () => {
  for (const payload of [
    batch(1, [hit(1, 2)]),
    batch(14, [hit(1, 1)]),
    batch(1, [hit(1, 1, { amount: 0 })]),
    batch(1, [hit(1, 1, { generation: 0 })]),
    batch(1, [hit(1, 1, { y: Infinity })]),
    batch(1, [hit(2, 1), hit(1, 1)]),
    batch(
      1,
      Array.from({ length: maxCombatDamageEvents + 1 }, (_, index) => hit(index + 1, 1))
    ),
  ])
    expect(parseCombatDamageBatch(payload)).toBeUndefined()
})
