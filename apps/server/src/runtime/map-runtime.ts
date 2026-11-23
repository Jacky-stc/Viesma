import type { CharacterId, MapInstanceId, MonsterId, SimulationTick } from '@viesma/domain'
import type { NormalizedMap } from '@viesma/game-data'
import { parseInputFrame, PROTOCOL_VERSION, type MapRoomJoin, type MovementCheckpoint, type PublicMapRoom } from '@viesma/protocol'
import {
  createMonsterFixture,
  createPlayer,
  createPlayerController,
  createSeededRng,
  getPlayerPresentationState,
  step,
  stepMonsterFixture,
  ticksPerSecond,
  type FixedTick,
  type MonsterFixture,
  type MonsterFixtureDefinition,
  type MonsterFixtureEvent,
  type PlayerInputCommand,
  type SimulationState,
} from '@viesma/simulation'

export const mapRoomCapacity = 20
const initialMapEpoch = 0
const inputRate = 40
const inputBurst = 80
const inputQueueCapacity = 6
type ParsedFrame = NonNullable<ReturnType<typeof parseInputFrame>>

interface QueuedFrame {
  readonly frame: ParsedFrame
  conflict: boolean
}

interface CharacterActor extends MapRoomJoin {
  readonly characterId: CharacterId
  readonly joinedMilliseconds: number
  readonly pending: QueuedFrame[]
  lastReceivedInputSeq: ParsedFrame['seq'] | null
  ackInputSeq: ParsedFrame['seq'] | null
  dead: boolean
  inputTokens: number
  lastRefillMilliseconds: number
}

export function createMapRuntime(
  mapInstanceId: MapInstanceId,
  map: NormalizedMap,
  spawn: NormalizedMap['spawns'][number],
  mapContentHash: string,
  initialTick: SimulationTick,
  nextId: () => string,
  fixture?: MonsterFixtureDefinition
) {
  const controller = createPlayerController(map)
  const rng = createSeededRng(1)
  const ids = {
    nextAttackId() {
      throw new Error('The M1 development room does not create attack entities')
    },
  }
  let state: SimulationState = { tick: initialTick, map: { mapId: map.id, mapInstanceId, players: [], monsters: [], attacks: [] } }
  let monster: MonsterFixture | undefined = fixture && createMonsterFixture(nextId() as MonsterId, fixture)
  const pendingFixtureEvents = new Set<MonsterFixtureEvent>()
  const acceptedFixtureEvents = new Set<MonsterFixtureEvent>()
  const actors = new Map<object, CharacterActor>()
  let disposed = false

  return {
    mapInstanceId,
    join(connection: object, nowMilliseconds: number): MapRoomJoin | undefined {
      if (disposed || actors.has(connection) || actors.size >= mapRoomCapacity) return undefined
      const binding = { characterId: nextId() as CharacterId, connectionEpoch: nextId(), mapEpoch: initialMapEpoch }
      actors.set(connection, {
        ...binding,
        joinedMilliseconds: nowMilliseconds,
        pending: [],
        lastReceivedInputSeq: null,
        ackInputSeq: null,
        dead: false,
        inputTokens: inputBurst,
        lastRefillMilliseconds: nowMilliseconds,
      })
      return binding
    },
    leave(connection: object): void {
      actors.delete(connection)
    },
    receive(connection: object, payload: unknown, nowMilliseconds: number): boolean {
      const actor = actors.get(connection)
      if (!actor || actor.dead) return false
      const elapsed = nowMilliseconds - actor.lastRefillMilliseconds
      actor.lastRefillMilliseconds = nowMilliseconds
      actor.inputTokens = Math.min(inputBurst, actor.inputTokens + (elapsed * inputRate) / 1000)
      if (actor.inputTokens < 1) return false
      actor.inputTokens -= 1

      const frame = parseInputFrame(payload)
      if (!frame || frame.connectionEpoch !== actor.connectionEpoch || frame.mapEpoch !== actor.mapEpoch) return false
      const maxSeq = inputBurst + Math.floor(((nowMilliseconds - actor.joinedMilliseconds) * ticksPerSecond) / 1000)
      if (frame.seq > maxSeq) return false
      if (actor.lastReceivedInputSeq !== null && frame.seq <= actor.lastReceivedInputSeq) {
        const newest = actor.pending.at(-1)
        const last = newest?.frame
        if (
          last &&
          frame.seq === last.seq &&
          (frame.moveX !== last.moveX || frame.jumpPressed !== last.jumpPressed || frame.attackPressed !== last.attackPressed)
        ) {
          newest.conflict = true
        }
        return false
      }
      actor.lastReceivedInputSeq = frame.seq
      // 保留最新意圖並捨棄舊 edge。下一 tick 結案最新幀時一併確認此前序號。
      if (actor.pending.length === inputQueueCapacity) actor.pending.length = 0
      actor.pending.push({ frame, conflict: false })
      return true
    },
    /** 測試介面僅供伺服器呼叫，於下一個 tick 套用。 */
    queueMonsterFixtureEvent(event: MonsterFixtureEvent): boolean {
      if (!monster || acceptedFixtureEvents.has(event)) return false
      acceptedFixtureEvents.add(event)
      pendingFixtureEvents.add(event)
      return true
    },
    advance({ tick, dtSeconds }: FixedTick): void {
      if (disposed) return
      const currentPlayers = new Map(state.map.players.map((player) => [player.characterId, player]))
      const players = []
      const commands: PlayerInputCommand[] = []
      // 僅在 tick 邊界建立與移除 body。step 依 characterId 排序角色並套用輸入。
      for (const actor of actors.values()) {
        const { characterId } = actor
        const player = currentPlayers.get(characterId) ?? createPlayer(characterId, spawn.position, true, spawn.facing)
        players.push(player)
        const pending = actor.pending.shift()
        if (!pending) continue
        actor.ackInputSeq = pending.frame.seq
        if (!pending.conflict)
          commands.push({
            kind: 'input',
            characterId,
            lifeStartedTick: player.lifeStartedTick,
            seq: pending.frame.seq,
            moveX: pending.frame.moveX,
            jumpPressed: pending.frame.jumpPressed,
          })
      }
      const result = step({ ...state, map: { ...state.map, players } }, commands, dtSeconds, {
        tick,
        rng,
        ids,
        playerController: controller,
      })
      state = result.state
      if (monster) monster = stepMonsterFixture(monster, pendingFixtureEvents)
      pendingFixtureEvents.clear()
      if (result.events.length === 0) return
      const deaths = new Set(result.events.filter(({ kind }) => kind === 'playerDied').map(({ characterId }) => characterId))
      for (const actor of actors.values()) {
        if (!deaths.has(actor.characterId)) continue
        actor.dead = true
        actor.pending.length = 0
        actor.ackInputSeq = actor.lastReceivedInputSeq
      }
    },
    snapshot(): PublicMapRoom {
      return {
        mapInstanceId,
        mapId: state.map.mapId,
        mapContentHash,
        serverTick: state.tick,
        players: state.map.players.map((player) => ({
          characterId: player.characterId,
          mapEpoch: initialMapEpoch,
          lifeStartedTick: player.lifeStartedTick,
          x: player.position.x,
          y: player.position.y,
          state: getPlayerPresentationState(player),
          facing: player.action.kind === 'attack' ? player.action.facing : player.facing,
          hp: player.vitals.hp,
          maxHp: player.vitals.maxHp,
        })),
        monsters: monster
          ? [
              {
                monsterId: monster.monsterId,
                archetypeId: monster.archetypeId,
                x: monster.position.x,
                y: monster.position.y,
                state: 'patrol',
                facing: monster.facing,
                hp: monster.hp,
                maxHp: monster.maxHp,
              },
            ]
          : [],
      }
    },
    checkpoint(connection: object): MovementCheckpoint | undefined {
      const actor = actors.get(connection)
      const player = actor && state.map.players.find(({ characterId }) => characterId === actor.characterId)
      if (!actor || !player) return undefined
      const { characterId, connectionEpoch, mapEpoch, ackInputSeq } = actor
      const { position, physics, movement, facing, locomotion, action, lastHurtTick, lifeStartedTick } = player
      return {
        protocolVersion: PROTOCOL_VERSION,
        characterId,
        connectionEpoch,
        mapEpoch,
        mapInstanceId,
        serverTick: state.tick,
        lifeStartedTick,
        ackInputSeq,
        controller: { position, physics, movement, facing, locomotion, action, lastHurtTick },
      }
    },
    dispose(): void {
      disposed = true
      actors.clear()
      monster = undefined
      pendingFixtureEvents.clear()
      acceptedFixtureEvents.clear()
      state = { ...state, map: { ...state.map, players: [] } }
    },
  }
}

export type MapRuntime = ReturnType<typeof createMapRuntime>
