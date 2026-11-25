import { initialMonsterAiBalance } from '@viesma/game-data'
import { maxCombatDamageAgeTicks, maxCombatDamageEvents, PROTOCOL_VERSION } from '@viesma/protocol'
import { allocateSoloExperience } from '@viesma/simulation'
import assert from 'node:assert/strict'
import { combatPeer, entrySlime, sendCombatInput, sharedCombatData } from './shared-combat-fixture.mjs'

export function createSharedCombatLoop(createWorldCoordinator, dependencies) {
  const data = sharedCombatData()
  const stats = {
    cycles: 0,
    joins: 0,
    voluntaryLeaves: 0,
    reconnects: 0,
    playerDamage: 0,
    playerDeaths: 0,
    villageRecoveries: 0,
    monsterDamage: 0,
    monsterDeaths: 0,
    monsterRespawns: 0,
    returnResets: 0,
    rewardCommits: 0,
    rewardReleases: 0,
    rewardExperience: 0,
    rewardGroundGrants: 0,
    rewardPrivateChecks: 0,
    rewardPickups: 0,
    maxPendingIntents: 0,
    maxRetainedReceipts: 0,
    maxRecentDamageEvents: 0,
    maxOutstandingInputFrames: 0,
    maxActivePlayers: 0,
    maxActiveMonsters: 0,
    maxTicksPerWake: 0,
    patrolMovementTicks: 0,
    chaseMovementTicks: 0,
    monsterAttackStarts: 0,
  }
  const receipts = new Map()
  let nextId = 0
  const world = createWorldCoordinator(data, 'shared-combat-fixture', {
    ...dependencies,
    nextId: () => `loop-${String(++nextId).padStart(6, '0')}`,
    rewardRandom: () => (bound) => bound - 1,
    wrapRewardPort: (memory) => ({
      commitReward(intent) {
        const { deathId } = intent.claim
        const receipt = memory.commitReward(intent)
        assert.equal(receipts.has(deathId), false, 'unexpected reward retry in the healthy loop')
        assert.equal(receipt.deathId, deathId)
        assert.equal(
          intent.groups.reduce((sum, group) => sum + group.effectiveDamage, 0),
          initialSlime.maxHp
        )
        const allocated = allocateSoloExperience(40, intent.groups)
        for (const { characterId, exp } of allocated) {
          assert.equal(receipt.recipients.find((recipient) => recipient.characterId === characterId)?.experience, exp)
        }
        assert.equal(receipt.grants.length, receipt.recipients.length)
        for (const { expiresAtUtcMilliseconds, content } of receipt.grants) {
          assert.equal(expiresAtUtcMilliseconds, receipt.committedAtUtcMilliseconds + 120_000)
          assert.equal(content.kind, 'currency')
        }
        stats.rewardExperience += receipt.recipients.reduce((sum, { experience }) => sum + experience, 0)
        stats.rewardGroundGrants += receipt.grants.length
        receipts.set(deathId, receipt)
        stats.rewardCommits++
        stats.maxRetainedReceipts = Math.max(stats.maxRetainedReceipts, receipts.size)
        return receipt
      },
      releaseReceipt(deathId) {
        assert.ok(receipts.delete(deathId))
        stats.rewardReleases++
        memory.releaseReceipt(deathId)
      },
    }),
  })
  const m1 = world.createRoom('m1')
  const village = world.createRoom('village')
  const initialSlime = entrySlime(m1)
  const originalCount = m1.snapshot().monsters.length
  const actors = Array.from({ length: 4 }, () => ({ peer: join() }))
  let phase = 'ready'
  let phaseTick = 0
  let tick = 0
  let mover
  let previousSlime = initialSlime
  let lastDamageId = 0
  let lastHurtTick
  const hurtActors = new Set()
  let corpseTick
  let pickup
  let pendingIntents = 0

  function join() {
    const peer = combatPeer()
    assert.ok(world.join(m1, peer), 'fresh admission failed')
    stats.joins++
    return peer
  }

  function input(actor, fields) {
    assert.ok(sendCombatInput(world, m1, actor.peer, fields), `input rejected during ${phase}`)
    const ack = world.checkpoint(m1, actor.peer.connection)?.ackInputSeq ?? 0
    stats.maxOutstandingInputFrames = Math.max(stats.maxOutstandingInputFrames, actor.peer.seq - ack)
    assert.ok(actor.peer.seq - ack <= 6)
  }

  function transition(next) {
    phase = next
    phaseTick = tick
  }

  function transfer(actor, destination, requestId) {
    const source = actor.peer
    assert.equal(source.offers.length, 1)
    const [offer] = source.offers
    assert.equal(offer.requestId, requestId)
    assert.equal(offer.mapId, destination.map.id)
    const next = combatPeer()
    assert.ok(world.acceptTransfer(destination, next, offer.ticket, source.session.reconnectToken))
    actor.peer = next
    return source
  }

  function churn() {
    const leaving = actors[(stats.cycles + 1) % actors.length]
    const leavingId = leaving.peer.session.characterId
    world.leave(m1, leaving.peer.connection)
    stats.voluntaryLeaves++
    assert.ok(!world.checkpoint(m1, leaving.peer.connection))
    leaving.peer = join()
    assert.notEqual(leaving.peer.session.characterId, leavingId)

    const recovering = actors[(stats.cycles + 2) % actors.length]
    const old = recovering.peer
    const next = combatPeer()
    world.leave(m1, old.connection, true)
    assert.ok(!world.checkpoint(m1, old.connection))
    assert.ok(world.reconnect(m1, next, old.session.reconnectToken))
    assert.equal(next.session.characterId, old.session.characterId)
    assert.notEqual(next.session.connectionEpoch, old.session.connectionEpoch)
    recovering.peer = next
    stats.reconnects++
  }

  return {
    world,
    afterWake(canStartCycle) {
      const field = m1.snapshot()
      const hub = village.snapshot()
      const elapsedTicks = field.serverTick - tick
      assert.ok(elapsedTicks >= 0 && elapsedTicks <= 5)
      assert.equal(hub.serverTick, field.serverTick)
      stats.maxTicksPerWake = Math.max(stats.maxTicksPerWake, elapsedTicks)
      if (!elapsedTicks) return
      tick = field.serverTick
      const actorsInRooms = [...field.players, ...hub.players].map(({ characterId }) => characterId)
      assert.equal(actorsInRooms.length, 4)
      assert.equal(new Set(actorsInRooms).size, 4)
      assert.equal(field.monsters.length, originalCount)
      assert.equal(hub.monsters.length, 0)
      assert.ok(field.monsters.length <= data.world.maxMonstersPerMap)
      assert.equal(new Set(field.monsters.map(({ monsterId }) => monsterId)).size, originalCount)
      stats.maxActivePlayers = Math.max(stats.maxActivePlayers, actorsInRooms.length)
      stats.maxActiveMonsters = Math.max(stats.maxActiveMonsters, field.monsters.length)
      pendingIntents = field.monsters.filter(({ state }) => state === 'rewardPending').length
      assert.ok(pendingIntents <= 1)
      stats.maxPendingIntents = Math.max(stats.maxPendingIntents, pendingIntents)

      const slime = entrySlime(m1)
      assert.ok(slime)
      const recent = m1.combatDamageSince(-1)?.events ?? []
      assert.ok(recent.length <= maxCombatDamageEvents)
      stats.maxRecentDamageEvents = Math.max(stats.maxRecentDamageEvents, recent.length)
      for (const event of recent) {
        assert.ok(tick - event.tick <= maxCombatDamageAgeTicks)
        if (event.id <= lastDamageId) continue
        lastDamageId = event.id
        if (event.kind === 'player') {
          assert.equal(event.targetId, mover?.peer.session.characterId)
          assert.ok(lastHurtTick === undefined || event.tick - lastHurtTick >= 30)
          lastHurtTick = event.tick
          hurtActors.add(event.targetId)
          stats.playerDamage++
        } else stats.monsterDamage++
      }
      if (slime.state === 'patrol' && previousSlime.state === 'patrol' && slime.x !== previousSlime.x) stats.patrolMovementTicks++
      if (phase === 'waitForAggro' && elapsedTicks === 1 && Math.abs(slime.x - previousSlime.x) > 2) stats.chaseMovementTicks++
      if (slime.state === 'attack' && previousSlime.state !== 'attack') stats.monsterAttackStarts++
      previousSlime = slime
      for (const actor of actors) assert.deepEqual(actor.peer.failures, [])
      assert.ok(phase === 'ready' || tick - phaseTick < 450, `loop stalled during ${phase} at tick ${tick}`)

      if (!world.canAdmit()) return

      const body = field.players.find(({ characterId }) => characterId === mover?.peer.session?.characterId)
      if (phase === 'ready' && canStartCycle) {
        mover = actors[stats.cycles % actors.length]
        lastHurtTick = undefined
        input(mover, { attackPressed: true })
        transition('wound')
      } else if (phase === 'wound' && slime.hp < slime.maxHp) {
        assert.ok(slime.hp > 0)
        churn()
        input(mover, { moveX: 1 })
        transition('bait')
      } else if (phase === 'bait') {
        input(mover, { moveX: 0 })
        transition('waitForAggro')
      } else if (phase === 'waitForAggro' && (slime.state === 'attack' || tick - phaseTick >= 18)) {
        input(mover, { moveX: 1 })
        transition('approach')
      } else if (phase === 'approach') {
        input(mover, { moveX: body.x < 431 ? 1 : 0 })
        if (body.x >= 431) transition('waitForPlayerDeath')
      } else if (phase === 'waitForPlayerDeath' && body.state === 'death') {
        assert.equal(body.hp, 0)
        stats.playerDeaths++
        transition('waitForVillageOffer')
      } else if (phase === 'waitForVillageOffer' && mover.peer.offers.length) {
        mover.source = transfer(mover, village, null)
        transition('waitForRecovery')
      } else if (phase === 'waitForRecovery' && mover.peer.session) {
        const { characterId, mapEpoch } = mover.peer.session
        assert.equal(mover.source.closes, 1)
        assert.equal(characterId, mover.source.session.characterId)
        assert.equal(mapEpoch, mover.source.session.mapEpoch + 1)
        const recovered = village.player(characterId)
        assert.equal(recovered.vitals.hp, recovered.vitals.maxHp)
        assert.equal(recovered.vitals.mp, recovered.vitals.maxMp)
        assert.equal(recovered.spawnProtected, true)
        stats.villageRecoveries++
        transition('waitForReturnReset')
      } else if (phase === 'waitForReturnReset' && slime.hp === slime.maxHp) {
        assert.equal(receipts.size, 0)
        assert.equal(slime.generation, stats.monsterRespawns + 1)
        stats.returnResets++
        assert.ok(
          world.requestPortal(village, mover.peer.connection, { requestId: 1, mapEpoch: mover.peer.session.mapEpoch, objectId: 'p_to_m1' })
        )
        transition('waitForFieldOffer')
      } else if (phase === 'waitForFieldOffer' && mover.peer.offers.length) {
        transfer(mover, m1, 1)
        transition('returnToField')
      } else if (phase === 'returnToField' && body) {
        assert.equal(body.spawnProtected, true)
        assert.equal(body.hp, body.maxHp)
        for (const actor of [...actors].reverse()) input(actor, { attackPressed: true })
        transition('waitForMonsterDeath')
      } else if (phase === 'waitForMonsterDeath' && slime.hp === 0) {
        stats.monsterDeaths++
        transition('waitForRespawn')
      } else if (phase === 'waitForRespawn' && slime.state === 'dead') {
        assert.equal(receipts.size, 1)
        if (corpseTick === undefined) {
          corpseTick = tick
          const [receipt] = receipts.values()
          for (const { peer } of actors) {
            const { characterId, connectionEpoch, mapEpoch } = peer.session
            const ownGrant = receipt.grants.find((grant) => grant.ownerCharacterId === characterId)
            const view = world.ownerGroundLoot(m1, peer.connection).update.loot
            const current = view.filter(({ lootId }) => receipt.grants.some((grant) => grant.lootId === lootId))
            assert.deepEqual(
              current.map(({ lootId }) => lootId),
              ownGrant ? [ownGrant.lootId] : []
            )
            stats.rewardPrivateChecks++
            if (!ownGrant || pickup) continue
            const { characterVersion, currency } = world.inventory(m1, peer.connection)
            world.requestGroundLoot(
              m1,
              peer.connection,
              {
                protocolVersion: PROTOCOL_VERSION,
                connectionEpoch,
                mapEpoch,
                requestId: stats.cycles + 1,
                expectedCharacterVersion: characterVersion,
                lootId: ownGrant.lootId,
              },
              'pickup'
            )
            pickup = { peer, characterVersion, currency: currency + ownGrant.content.amount, lootId: ownGrant.lootId }
          }
          assert.ok(pickup)
        } else if (pickup) {
          const { peer, currency, characterVersion, lootId } = pickup
          assert.equal(world.inventory(m1, peer.connection).currency, currency)
          assert.equal(world.inventory(m1, peer.connection).characterVersion, characterVersion + 1)
          assert.ok(world.ownerGroundLoot(m1, peer.connection).update.loot.every((entry) => entry.lootId !== lootId))
          stats.rewardPickups++
          pickup = undefined
        }
      } else if (phase === 'waitForRespawn' && slime.generation === stats.monsterRespawns + 2) {
        assert.ok(
          corpseTick !== undefined &&
            tick - corpseTick >= initialMonsterAiBalance.corpseTicks + initialMonsterAiBalance.respawnWaitTicks - 4
        )
        assert.equal(receipts.size, 0)
        assert.equal(pickup, undefined)
        assert.equal(slime.hp, slime.maxHp)
        corpseTick = undefined
        stats.monsterRespawns++
        stats.cycles++
        transition('ready')
      }
    },
    result(minimumCycles) {
      assert.equal(phase, 'ready')
      assert.ok(stats.cycles >= minimumCycles, `only ${stats.cycles} completed cycles`)
      const { cycles } = stats
      for (const key of [
        'voluntaryLeaves',
        'reconnects',
        'playerDeaths',
        'villageRecoveries',
        'monsterDeaths',
        'monsterRespawns',
        'returnResets',
        'rewardCommits',
        'rewardReleases',
        'rewardPickups',
      ]) {
        assert.equal(stats[key], cycles, key)
      }
      assert.equal(stats.joins, cycles + 4)
      assert.equal(stats.rewardPrivateChecks, cycles * 4)
      assert.ok(stats.rewardGroundGrants >= cycles && stats.rewardExperience > 0)
      assert.ok(stats.playerDamage >= 2 * cycles && stats.monsterDamage >= 2 * cycles)
      assert.ok(stats.monsterAttackStarts >= 2 * cycles && stats.patrolMovementTicks > 0 && stats.chaseMovementTicks > 0)
      assert.ok(hurtActors.size >= Math.min(cycles, 2))
      assert.equal(pendingIntents, 0)
      assert.equal(receipts.size, 0)
      return {
        ticks: tick,
        activePlayers: m1.snapshot().players.length + village.snapshot().players.length,
        activeMonsters: m1.snapshot().monsters.length,
        spawnCap: data.world.maxMonstersPerMap,
        pendingIntents,
        retainedReceipts: receipts.size,
        hurtActorCount: hurtActors.size,
        ...stats,
        ...world.tickDiagnostics(),
      }
    },
    dispose() {
      world.disposeRoom(m1)
      world.disposeRoom(village)
      assert.equal(m1.hasRetainedSeats(), false)
      assert.equal(village.hasRetainedSeats(), false)
      assert.deepEqual(m1.snapshot().monsters, [])
      assert.deepEqual(village.snapshot().players, [])
    },
  }
}
