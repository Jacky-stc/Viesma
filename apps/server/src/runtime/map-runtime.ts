import type { AttackId, CharacterId, DerivedCombatStats, EncounterId, MapInstanceId, MonsterId, SimulationTick } from '@viesma/domain'
import type { NormalizedMap } from '@viesma/game-data'
import {
  maxCombatDamageAgeTicks,
  maxCombatDamageEvents,
  parseInputFrame,
  PROTOCOL_VERSION,
  type CombatDamage,
  type CombatDamageBatch,
  type MapRoomJoin,
  type MovementCheckpoint,
  type PublicMapRoom,
} from '@viesma/protocol'
import {
  applyPlayerVitalEffects,
  clampPlayerVitals,
  createMonsterMovement,
  createPlayer,
  createPlayerController,
  createSeededRng,
  createSolidObstructionTest,
  getPlayerPresentationState,
  neutralMovement,
  spawnMonsters,
  step,
  ticksPerSecond,
  type CombatDamageEvent,
  type FixedTick,
  type MonsterSpawnDefinition,
  type PartyMembership,
  type PlayerInputCommand,
  type SimulationPlayer,
  type SimulationState,
} from '@viesma/simulation'
import type { EncounterRewardWorker } from './encounter-reward-worker.ts'
import type { ConsumableEffect, ConsumableOutcome } from './memory-character-repository.ts'
import type { InputDecision, MovementTraceSink, WatchMovement } from './movement-trace.ts'

export const mapRoomCapacity = 20
const initialMapEpoch = 0
const inputRate = 40
const inputBurst = 80
const inputQueueCapacity = 6
const inputQueueTtlMilliseconds = 200
type ParsedFrame = NonNullable<ReturnType<typeof parseInputFrame>>

interface QueuedFrame {
  readonly frame: ParsedFrame
  readonly receivedMilliseconds: number
  conflict: boolean
}

interface CharacterSeat extends MapRoomJoin {
  readonly characterId: CharacterId
  readonly joinedMilliseconds: number
  readonly pending: QueuedFrame[]
  lastReceivedInputSeq: ParsedFrame['seq'] | null
  ackInputSeq: ParsedFrame['seq'] | null
  dead: boolean
  frozen: boolean
  connected: boolean
  inputTokens: number
  lastRefillMilliseconds: number
}

function createSeat(binding: MapRoomJoin & { characterId: CharacterId }, nowMilliseconds: number, dead = false): CharacterSeat {
  return {
    ...binding,
    joinedMilliseconds: nowMilliseconds,
    pending: [],
    lastReceivedInputSeq: null,
    ackInputSeq: null,
    dead,
    frozen: false,
    connected: true,
    inputTokens: inputBurst,
    lastRefillMilliseconds: nowMilliseconds,
  }
}

function expireQueuedInputs(pending: QueuedFrame[], nowMilliseconds: number, serverTick: number, trace?: MovementTraceSink): void {
  while (pending[0] && nowMilliseconds - pending[0].receivedMilliseconds > inputQueueTtlMilliseconds) {
    const { frame, receivedMilliseconds } = pending[0]
    pending.shift()
    trace?.({ kind: 'input-retired', serverTick, inputSeq: frame.seq, reason: 'ttl', ageMs: nowMilliseconds - receivedMilliseconds })
  }
}

interface MapCombatOptions {
  readonly playerStats: (characterId: CharacterId) => DerivedCombatStats
  readonly balanceVersion: string
  readonly rewards: EncounterRewardWorker
  readonly partyMembership?: (characterId: CharacterId) => PartyMembership | undefined
}

export function createMapRuntime(
  mapInstanceId: MapInstanceId,
  map: NormalizedMap,
  spawn: NormalizedMap['spawns'][number],
  mapContentHash: string,
  initialTick: SimulationTick,
  nextId: () => string,
  monsterSpawns?: { readonly definitions: readonly MonsterSpawnDefinition[]; readonly maxActive: number },
  roomId: string = mapInstanceId,
  combatOptions?: MapCombatOptions,
  watchMovement?: WatchMovement
) {
  const controller = createPlayerController(map)
  const rng = createSeededRng(1)
  const monsterIds = {
    nextMonsterId: () => nextId() as MonsterId,
    nextEncounterId: () => nextId() as EncounterId,
  }
  const rewards = combatOptions?.rewards
  const monsterContext = {
    move: createMonsterMovement(map.colliders),
    ...monsterIds,
    ...(rewards && { receiptFor: rewards.receipt }),
  }
  const ids = { nextAttackId: () => nextId() as AttackId }
  let state: SimulationState = {
    tick: initialTick,
    map: {
      mapId: map.id,
      mapInstanceId,
      players: [],
      monsters: monsterSpawns ? spawnMonsters(monsterSpawns.definitions, monsterSpawns.maxActive, monsterIds, rng) : [],
      attacks: [],
    },
  }
  const seats = new Map<CharacterId, CharacterSeat>()
  const bindings = new Map<object, CharacterSeat>()
  const reservations = new Set<CharacterId>()
  const recentDamage: CombatDamage[] = []
  let damageId = 0
  let disposed = false
  const combat = combatOptions && {
    playerStats: combatOptions.playerStats,
    balanceVersion: combatOptions.balanceVersion,
    isObstructed: createSolidObstructionTest(map.colliders),
    participant(characterId: CharacterId) {
      const seat = seats.get(characterId)
      if (!seat) return undefined
      const membership = combatOptions.partyMembership?.(characterId)
      return { connected: seat.connected && !seat.frozen, ...(membership && { membership }) }
    },
  }

  function releaseRemovedClaims(nextMonsters: SimulationState['map']['monsters']) {
    if (!rewards || !state.map.monsters.some(({ behavior }) => 'deathId' in behavior)) return
    const survivors = new Set(nextMonsters.map(({ monsterId }) => monsterId))
    for (const { monsterId, behavior } of state.map.monsters) {
      if ('deathId' in behavior && !survivors.has(monsterId)) rewards.releaseEncounter(behavior.deathId)
    }
  }

  function player(characterId: CharacterId) {
    return state.map.players.find((body) => body.characterId === characterId)
  }

  function recordDamage(event: CombatDamageEvent) {
    const fields = { tick: event.tick, amount: event.effectiveDamage }
    if (event.kind === 'monsterDamaged') {
      const monster = state.map.monsters.find(
        ({ monsterId, encounterId }) => monsterId === event.monsterId && encounterId === event.encounterId
      )
      if (!monster) return
      recentDamage.push({
        ...fields,
        ...monster.position,
        id: ++damageId,
        kind: 'monster',
        targetId: monster.monsterId,
        generation: monster.generation,
        critical: event.critical,
      })
    } else {
      const seat = seats.get(event.characterId)
      const body = player(event.characterId)
      if (!body || !seat) return
      recentDamage.push({
        ...fields,
        ...body.position,
        id: ++damageId,
        kind: 'player',
        targetId: body.characterId,
        lifeStartedTick: body.lifeStartedTick,
        mapEpoch: seat.mapEpoch,
        critical: false,
      })
    }
    if (recentDamage.length > maxCombatDamageEvents) recentDamage.shift()
  }

  function putPlayer(body: SimulationPlayer) {
    state = {
      ...state,
      map: { ...state.map, players: [...state.map.players.filter(({ characterId }) => characterId !== body.characterId), body] },
    }
  }

  function clearInput(seat: CharacterSeat, resetSequence = false) {
    const trace = watchMovement?.(seat.characterId)
    if (trace) {
      for (const { frame } of seat.pending)
        trace({ kind: 'input-retired', serverTick: state.tick, inputSeq: frame.seq, reason: 'cleared', ageMs: null })
    }
    seat.pending.length = 0
    const body = player(seat.characterId)
    if (!body) return
    const movement = resetSequence ? neutralMovement : { ...neutralMovement, lastProcessedInputSeq: body.movement.lastProcessedInputSeq }
    putPlayer({ ...body, movement })
  }

  const hasCapacity = () => !disposed && seats.size + reservations.size < mapRoomCapacity

  return {
    mapInstanceId,
    roomId,
    map,
    player,
    hasCapacity,
    hasRetainedSeats: () => reservations.size > 0 || seats.size > bindings.size,
    reserve(characterId: CharacterId): boolean {
      if (!hasCapacity() || seats.has(characterId) || reservations.has(characterId)) return false
      reservations.add(characterId)
      return true
    },
    cancelReservation(characterId: CharacterId): void {
      reservations.delete(characterId)
    },
    prepareArrival(
      connection: object,
      binding: MapRoomJoin & { characterId: CharacterId },
      body: SimulationPlayer,
      nowMilliseconds: number
    ): (() => void) | undefined {
      const { characterId } = binding
      if (
        disposed ||
        body.characterId !== characterId ||
        !reservations.has(characterId) ||
        bindings.has(connection) ||
        seats.has(characterId) ||
        player(characterId)
      )
        return undefined
      const seat = createSeat(binding, nowMilliseconds)
      const arrival = { ...state, map: { ...state.map, players: [...state.map.players, body] } }
      return () => {
        reservations.delete(characterId)
        seats.set(characterId, seat)
        bindings.set(connection, seat)
        state = arrival
      }
    },
    binding(connection: object): MapRoomJoin | undefined {
      const seat = bindings.get(connection)
      if (seat) {
        const { characterId, connectionEpoch, mapEpoch } = seat
        return { characterId, connectionEpoch, mapEpoch }
      }
    },
    updatePlayerMaxima(characterId: CharacterId, stats: DerivedCombatStats): void {
      const body = player(characterId)
      if (body) putPlayer(clampPlayerVitals(body, stats))
    },
    applyConsumable(characterId: CharacterId, effect: ConsumableEffect, tick: SimulationTick): ConsumableOutcome {
      // 權威席位包含凍結的來源與 grace 保留的 body。預留席位尚未安裝。
      const body = !disposed && seats.has(characterId) ? player(characterId) : undefined
      if (!body || body.lifeStartedTick !== effect.lifeStartedTick) return 'CONSUMED_NO_EFFECT'
      if (body.action.kind === 'death' || body.vitals.hp <= 0) return 'CONSUMED_DEAD'
      if (body.physics.inVoid) return 'CONSUMED_NO_EFFECT'
      putPlayer(applyPlayerVitalEffects(body, [effect], tick))
      return 'CONFIRMED'
    },
    freeze(connection: object): void {
      const seat = bindings.get(connection)
      if (!seat) return
      seat.frozen = true
      clearInput(seat)
      const body = player(seat.characterId)
      if (body && body.action.kind !== 'death') {
        putPlayer({ ...body, physics: { ...body.physics, velocity: { x: 0, y: 0 } }, locomotion: 'idle' })
      }
    },
    resume(connection: object): void {
      const seat = bindings.get(connection)
      if (seat) seat.frozen = false
    },
    respawn(connection: object, body: SimulationPlayer): void {
      const seat = bindings.get(connection)
      if (!seat || seat.characterId !== body.characterId) return
      seat.dead = false
      putPlayer(body)
    },
    prepareDeparture(connection: object, characterId: CharacterId): (() => void) | undefined {
      const seat = bindings.get(connection)
      if (disposed || !seat?.frozen || seat.characterId !== characterId || seats.get(characterId) !== seat || !player(characterId))
        return undefined
      const departure = { ...state, map: { ...state.map, players: state.map.players.filter((body) => body.characterId !== characterId) } }
      return () => {
        bindings.delete(connection)
        seats.delete(characterId)
        state = departure
      }
    },
    join(connection: object, nowMilliseconds: number): MapRoomJoin | undefined {
      if (!hasCapacity() || bindings.has(connection)) return undefined
      const binding = { characterId: nextId() as CharacterId, connectionEpoch: nextId(), mapEpoch: initialMapEpoch }
      const seat = createSeat(binding, nowMilliseconds)
      seats.set(binding.characterId, seat)
      bindings.set(connection, seat)
      return binding
    },
    leave(connection: object): void {
      const seat = bindings.get(connection)
      if (!seat) return
      bindings.delete(connection)
      seats.delete(seat.characterId)
    },
    detach(connection: object): void {
      const seat = bindings.get(connection)
      if (!seat) return
      bindings.delete(connection)
      seat.connected = false
      seat.frozen = false
      clearInput(seat)
    },
    rebind(characterId: CharacterId, connection: object, nowMilliseconds: number): MapRoomJoin | undefined {
      const previous = seats.get(characterId)
      if (disposed || !previous) return undefined
      const binding = { characterId, connectionEpoch: nextId(), mapEpoch: previous.mapEpoch }
      const seat = createSeat(binding, nowMilliseconds, previous.dead)
      seats.set(characterId, seat)
      bindings.set(connection, seat)
      clearInput(seat, true)
      return binding
    },
    release(characterId: CharacterId): void {
      seats.delete(characterId)
    },
    receive(connection: object, payload: unknown, nowMilliseconds: number): boolean {
      const actor = bindings.get(connection)
      if (!actor) return false
      const trace = watchMovement?.(actor.characterId)
      function decide(reason: InputDecision, inputSeq: number | null) {
        trace?.({ kind: 'input-decision', serverTick: state.tick, inputSeq, reason, queueDepth: actor?.pending.length ?? 0 })
        return reason === 'queued'
      }
      if (actor.dead || actor.frozen) return decide(actor.dead ? 'dead' : 'frozen', null)
      const elapsed = nowMilliseconds - actor.lastRefillMilliseconds
      actor.lastRefillMilliseconds = nowMilliseconds
      actor.inputTokens = Math.min(inputBurst, actor.inputTokens + (elapsed * inputRate) / 1000)
      if (actor.inputTokens < 1) return decide('rate', null)
      actor.inputTokens -= 1

      const frame = parseInputFrame(payload)
      if (!frame) return decide('invalid-frame', null)
      if (frame.connectionEpoch !== actor.connectionEpoch || frame.mapEpoch !== actor.mapEpoch) return decide('epoch', frame.seq)
      const maxSeq = inputBurst + Math.floor(((nowMilliseconds - actor.joinedMilliseconds) * ticksPerSecond) / 1000)
      if (frame.seq > maxSeq) return decide('ahead', frame.seq)
      expireQueuedInputs(actor.pending, nowMilliseconds, state.tick, trace)
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
        return decide('duplicate', frame.seq)
      }
      actor.lastReceivedInputSeq = frame.seq
      if (actor.pending.length === inputQueueCapacity) {
        const evicted = actor.pending.findIndex(({ conflict, frame }) => conflict || (!frame.jumpPressed && !frame.attackPressed))
        if (evicted === -1) return decide('queue-full', frame.seq)
        const [removed] = actor.pending.splice(evicted, 1)
        if (removed)
          trace?.({
            kind: 'input-retired',
            serverTick: state.tick,
            inputSeq: removed.frame.seq,
            reason: 'evicted',
            ageMs: nowMilliseconds - removed.receivedMilliseconds,
          })
      }
      actor.pending.push({ frame, receivedMilliseconds: nowMilliseconds, conflict: false })
      return decide('queued', frame.seq)
    },
    advance({ tick, dtSeconds }: FixedTick, nowMilliseconds: number): void {
      if (disposed) return
      const currentPlayers = new Map(state.map.players.map((player) => [player.characterId, player]))
      const players = []
      const frozen = []
      const commands: PlayerInputCommand[] = []
      const traced = watchMovement && new Map<string, { trace: MovementTraceSink; before: SimulationPlayer; applied?: ParsedFrame }>()
      // 僅在 tick 邊界建立與移除 body。step 依 characterId 排序角色並套用輸入。
      for (const actor of seats.values()) {
        const { characterId } = actor
        const player =
          currentPlayers.get(characterId) ??
          createPlayer(characterId, spawn.position, true, spawn.facing, combatOptions?.playerStats(characterId))
        if (actor.frozen) {
          frozen.push(player)
          continue
        }
        players.push(player)
        const trace = watchMovement?.(characterId)
        expireQueuedInputs(actor.pending, nowMilliseconds, tick, trace)
        const pending = actor.pending.shift()
        const applied = pending?.conflict ? undefined : pending?.frame
        if (trace) {
          traced?.set(characterId, { trace, before: player, ...(applied && { applied }) })
          if (pending?.conflict)
            trace({
              kind: 'input-retired',
              serverTick: tick,
              inputSeq: pending.frame.seq,
              reason: 'conflict',
              ageMs: nowMilliseconds - pending.receivedMilliseconds,
            })
        }
        if (applied)
          commands.push({
            kind: 'input',
            characterId,
            lifeStartedTick: player.lifeStartedTick,
            seq: applied.seq,
            moveX: applied.moveX,
            jumpPressed: applied.jumpPressed,
            attackPressed: applied.attackPressed,
          })
      }
      const observedController: typeof controller = (before, input, events, tick) => {
        const after = controller(before, input, events, tick)
        if ('characterId' in before && typeof before.characterId === 'string')
          traced?.get(before.characterId)?.trace({
            kind: 'controller',
            serverTick: tick,
            inputSeq: input?.seq ?? null,
            jumpPressed: input?.jumpPressed ?? false,
            before,
            after,
          })
        return after
      }
      const result = step({ ...state, map: { ...state.map, players } }, commands, dtSeconds, {
        tick,
        rng,
        ids,
        playerController: traced?.size ? observedController : controller,
        monsters: monsterContext,
        ...(combat && { combat: { ...combat, admitAttacks: rewards?.canAdmitAttacks() ?? true } }),
      })
      releaseRemovedClaims(result.state.map.monsters)
      state =
        frozen.length === 0
          ? result.state
          : { ...result.state, map: { ...result.state.map, players: [...result.state.map.players, ...frozen] } }
      const deaths = new Set<CharacterId>()
      for (const event of result.events) {
        if (event.kind === 'playerDied') deaths.add(event.characterId)
        if (event.kind === 'monsterDeathClaimed') rewards?.accept(event.intent)
        if (event.kind === 'monsterDamaged' || event.kind === 'playerDamaged') recordDamage(event)
        if (event.kind === 'playerDamaged') watchMovement?.(event.characterId)?.({ kind: 'damage', event })
      }
      while (recentDamage[0] && tick - recentDamage[0].tick > maxCombatDamageAgeTicks) recentDamage.shift()
      for (const actor of seats.values()) {
        if (deaths.has(actor.characterId)) {
          actor.dead = true
          const trace = watchMovement?.(actor.characterId)
          if (trace) {
            for (const { frame, receivedMilliseconds } of actor.pending)
              trace({
                kind: 'input-retired',
                serverTick: tick,
                inputSeq: frame.seq,
                reason: 'death',
                ageMs: nowMilliseconds - receivedMilliseconds,
              })
          }
          actor.pending.length = 0
        }
        const firstOutstanding = actor.pending[0]?.frame.seq
        // 佇列嚴格遞增，且本 tick 已移除首幀，所以剩餘的首序號至少為 1。
        actor.ackInputSeq = firstOutstanding === undefined ? actor.lastReceivedInputSeq : ((firstOutstanding - 1) as ParsedFrame['seq'])
      }
      if (traced?.size) {
        for (const after of state.map.players) {
          const entry = traced.get(after.characterId)
          entry?.trace({
            kind: 'tick',
            serverTick: tick,
            inputSeq: entry.applied?.seq ?? null,
            jumpPressed: entry.applied?.jumpPressed ?? false,
            before: entry.before,
            after,
          })
        }
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
          mapEpoch: seats.get(player.characterId)?.mapEpoch ?? initialMapEpoch,
          lifeStartedTick: player.lifeStartedTick,
          x: player.position.x,
          y: player.position.y,
          state: getPlayerPresentationState(player),
          facing: player.action.kind === 'attack' ? player.action.facing : player.facing,
          hp: player.vitals.hp,
          maxHp: player.vitals.maxHp,
          spawnProtected: player.spawnProtected && player.action.kind !== 'death',
        })),
        monsters: state.map.monsters.map((monster) => ({
          monsterId: monster.monsterId,
          generation: monster.generation,
          archetypeId: monster.spawn.archetypeId,
          x: monster.position.x,
          y: monster.position.y,
          state: monster.behavior.kind === 'chase' || monster.behavior.kind === 'return' ? 'patrol' : monster.behavior.kind,
          facing: monster.facing,
          hp: monster.hp,
          maxHp: monster.spawn.maxHp,
        })),
      }
    },
    combatDamageSince(previousTick: number): CombatDamageBatch | undefined {
      const events = recentDamage.filter(({ tick }) => tick > previousTick)
      if (events.length) return { mapInstanceId, serverTick: state.tick, events }
    },
    checkpoint(connection: object): MovementCheckpoint | undefined {
      const actor = bindings.get(connection)
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
        controller: {
          position,
          physics,
          movement,
          facing,
          locomotion,
          action: action.kind === 'attack' ? { kind: 'attack', facing: action.facing } : action,
          lastHurtTick,
        },
      }
    },
    dispose(): void {
      disposed = true
      seats.clear()
      bindings.clear()
      reservations.clear()
      recentDamage.length = 0
      releaseRemovedClaims([])
      state = { ...state, map: { ...state.map, players: [], monsters: [] } }
    },
  }
}

export type MapRuntime = ReturnType<typeof createMapRuntime>
