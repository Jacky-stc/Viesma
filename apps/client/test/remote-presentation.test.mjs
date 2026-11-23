import { expect, test } from 'vitest'
import { createRemotePresentation } from '../src/multiplayer/remote-presentation.ts'

const source = { mapInstanceId: 'instance', mapId: 'm1', connectionEpoch: 'connection-1', mapEpoch: 0 }
const runner = (x, fields = {}) => ({
  characterId: 'peer',
  x,
  y: 800,
  state: 'run',
  facing: 'right',
  mapEpoch: 0,
  lifeStartedTick: 0,
  hp: 50,
  maxHp: 50,
  ...fields,
})
const slime = (x, hp = 71) => ({ monsterId: 'slime-1', archetypeId: 'slime', x, y: 896, state: 'patrol', facing: 'right', hp, maxHp: 71 })
const peerAt = (view, milliseconds) => view.sample(milliseconds).peers.get('peer')

test('interpolates presentation in server ticks without changing the authoritative samples', () => {
  const view = createRemotePresentation()
  const first = Object.freeze(runner(0, { state: 'idle' }))
  const latest = Object.freeze(runner(12, { y: 812, hp: 40 }))
  view.receive(source, 0, 1000, [first], [slime(465)])
  expect(peerAt(view, 1050)).toMatchObject({ position: { x: 0, y: 800 }, mode: 'hold' })
  view.receive(source, 3, 1100, [latest], [slime(471, 35)])
  const { peers, monsters } = view.sample(1150)
  expect(peers.get('peer')).toMatchObject({ position: { x: 6, y: 806 }, visualTick: 1.5, mode: 'interpolate', state: 'idle' })
  expect(monsters.get('slime-1')).toMatchObject({ position: { x: 468, y: 896 }, visualTick: 1.5 })
  expect(latest).toMatchObject({ x: 12, y: 812, hp: 40 })
  expect(peerAt(view, 1201)).toMatchObject({ state: 'run' })
})

test('tolerates jitter and one missing patch, rejecting stale and duplicate data', () => {
  const view = createRemotePresentation()
  view.receive(source, 30, 1000, [runner(0)], [])
  view.receive(source, 33, 1130, [runner(12)], [])
  expect(peerAt(view, 1150).position.x).toBeCloseTo(6)
  expect(view.receive(source, 33, 1160, [], [])).toBe(false)
  expect(view.receive(source, 32, 1170, [runner(999)], [])).toBe(false)
  view.receive(source, 39, 1325, [runner(36)], [])
  expect(peerAt(view, 1350).position.x).toBeCloseTo(30)
  expect(peerAt(view, 1340).position.x).toBeCloseTo(30)
  expect(view.diagnostics()).toMatchObject({ clockSamples: 3, players: [['peer', 3]] })
})

test('caps stall extrapolation at one interval and holds monsters at the last authority position', () => {
  const view = createRemotePresentation()
  view.receive(source, 0, 1000, [runner(0)], [slime(465)])
  view.receive(source, 3, 1100, [runner(12)], [slime(471)])
  const extrapolating = peerAt(view, 1250)
  expect(extrapolating).toMatchObject({ position: { y: 800 }, mode: 'extrapolate' })
  expect(extrapolating.position.x).toBeCloseTo(18)
  expect(extrapolating.visualTick).toBeCloseTo(4.5)
  const stalled = peerAt(view, 10000)
  expect(stalled).toMatchObject({ position: { x: 24, y: 800 }, visualTick: 6, mode: 'hold' })
  expect(peerAt(view, 15000)).toEqual(stalled)
  expect(view.sample(15000).monsters.get('slime-1').position.x).toBe(471)
  view.receive(source, 15, 15010, [runner(42)], [slime(495)])
  expect(peerAt(view, 15010)).toMatchObject({ position: { x: 42, y: 800 }, visualTick: 15, mode: 'hold' })
  expect(view.sample(15010).monsters.get('slime-1').position.x).toBe(495)
})

test.each([
  ['teleport displacement', runner(3000)],
  ['remote map epoch', runner(12, { mapEpoch: 1 })],
  ['new life', runner(12, { lifeStartedTick: 3 })],
  ['death', runner(12, { state: 'death', hp: 0 })],
])('snaps across %s and never extrapolates a discontinuity', (_label, after) => {
  const view = createRemotePresentation()
  view.receive(source, 0, 1000, [runner(0)], [])
  view.receive(source, 3, 1100, [after], [])
  expect(peerAt(view, 1101)).toMatchObject({ position: { x: after.x, y: after.y }, mode: 'hold', visualTick: 3 })
  expect(peerAt(view, 1350).position.x).toBe(after.x)
})

test.each([{ connectionEpoch: 'new-connection' }, { mapInstanceId: 'new-instance' }, { mapId: 'village' }, { mapEpoch: 1 }])(
  'resets the full buffer for a new source %o even when server ticks restart',
  (change) => {
    const view = createRemotePresentation()
    view.receive(source, 9, 1000, [runner(100)], [slime(465)])
    view.receive(source, 12, 1100, [runner(112)], [slime(471)])
    expect(view.receive({ ...source, ...change }, 1, 1200, [runner(30)], [])).toBe(true)
    expect(peerAt(view, 1200)).toMatchObject({ position: { x: 30, y: 800 }, visualTick: 1 })
    expect(view.diagnostics()).toEqual({ clockSamples: 1, players: [['peer', 1]], monsters: [] })
  }
)

test('bounds history and clears removed or rejoining entities and disposed rooms', () => {
  const view = createRemotePresentation()
  for (let index = 0; index < 40; index++) {
    view.receive(source, index * 3, index * 100, [runner(index * 12)], [slime(465 + index)])
  }
  expect(view.diagnostics()).toEqual({ clockSamples: 8, players: [['peer', 8]], monsters: [['slime-1', 8]] })
  view.receive(source, 120, 4000, [], [slime(505)])
  expect(view.sample(4000).peers.size).toBe(0)
  expect(view.sample(4000).monsters.size).toBe(1)
  view.receive(source, 123, 4100, [runner(12, { characterId: 'new-peer' })], [])
  expect(view.sample(4100).monsters.size).toBe(0)
  expect(view.sample(4100).peers.get('new-peer').position.x).toBe(12)
  view.receive(source, 126, 4200, [runner(88)], [])
  expect(peerAt(view, 4200).position.x).toBe(88)
  view.clear()
  expect(view.sample(5000)).toEqual({ peers: new Map(), monsters: new Map() })
  expect(view.diagnostics()).toEqual({ clockSamples: 0, players: [], monsters: [] })
})
