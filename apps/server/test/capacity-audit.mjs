import { initialEncounterRewardBalance } from '@viesma/game-data'
import { allocateSoloExperience } from '@viesma/simulation'
import { Buffer } from 'node:buffer'
import { createHistogram, performance } from 'node:perf_hooks'
import { count, counters, distribution, record } from './capacity-observe.mjs'

export function observeSeats(runtime, metrics, incident) {
  const { connections, disconnected, incoming } = metrics
  function check() {
    const reserved = disconnected.size + incoming.size
    const seats = connections.size + reserved
    metrics.activePeak = Math.max(metrics.activePeak, connections.size)
    metrics.reservedPeak = Math.max(metrics.reservedPeak, reserved)
    metrics.seatsPeak = Math.max(metrics.seatsPeak, seats)
    if (seats > 20 || seats < 20 !== runtime.hasCapacity()) incident('Authoritative seat accounting/cap mismatch')
  }
  const join = runtime.join
  runtime.join = (socket, now) => {
    const result = join(socket, now)
    if (result) connections.set(socket, result.characterId)
    check()
    return result
  }
  const reserve = runtime.reserve
  runtime.reserve = (characterId) => {
    const result = reserve(characterId)
    if (result) incoming.add(characterId)
    check()
    return result
  }
  const cancel = runtime.cancelReservation
  runtime.cancelReservation = (characterId) => {
    cancel(characterId)
    incoming.delete(characterId)
    check()
  }
  const leave = runtime.leave
  runtime.leave = (socket) => {
    leave(socket)
    connections.delete(socket)
    check()
  }
  const detach = runtime.detach
  runtime.detach = (socket) => {
    const characterId = connections.get(socket)
    detach(socket)
    if (connections.delete(socket)) disconnected.add(characterId)
    check()
  }
  const rebind = runtime.rebind
  runtime.rebind = (characterId, socket, now) => {
    const result = rebind(characterId, socket, now)
    if (result) {
      if (!disconnected.delete(characterId)) incident('Reconnect consumed no reserved seat')
      connections.set(socket, characterId)
    }
    check()
    return result
  }
  const release = runtime.release
  runtime.release = (characterId) => {
    release(characterId)
    disconnected.delete(characterId)
    check()
  }
  const prepareDeparture = runtime.prepareDeparture
  runtime.prepareDeparture = (socket, characterId) => {
    const commit = prepareDeparture(socket, characterId)
    if (!commit) return
    return () => {
      commit()
      connections.delete(socket)
      check()
    }
  }
  const prepareArrival = runtime.prepareArrival
  runtime.prepareArrival = (socket, binding, ...rest) => {
    const commit = prepareArrival(socket, binding, ...rest)
    if (!commit) return
    return () => {
      commit()
      if (!incoming.delete(binding.characterId)) incident('Transfer consumed no reserved seat')
      connections.set(socket, binding.characterId)
      check()
    }
  }
}

export function createAudit(data, spawnDefinitions, incident) {
  const deaths = new Map()
  const grants = new Map()
  const picked = new Set()
  const receipts = new Map()
  const commands = new Map()
  const stats = counters()
  const rewardLatency = createHistogram()
  const mutationLatency = createHistogram()
  const baseExperience = new Map(spawnDefinitions.map((spawn) => [spawn.spawnId, spawn.baseExp]))
  let repository
  let readReceipt
  let receiptCount = 0
  let receiptPayloadBytes = 0
  let pending = 0
  let pendingPeak = 0
  let commandPeak = 0
  const expTotal = (character) =>
    data.progression.expToNextLevel.slice(0, character.level - 1).reduce((sum, value) => sum + value, character.expWithinLevel)

  return {
    stats,
    grants,
    deathClaimed(claim, room) {
      if (deaths.has(claim.deathId)) return incident('Duplicate authoritative monster death')
      deaths.set(claim.deathId, { claim, room, started: performance.now(), attempts: 0 })
      pendingPeak = Math.max(pendingPeak, ++pending)
    },
    wrapRewardPort(memory) {
      return {
        releaseReceipt(deathId) {
          memory.releaseReceipt(deathId)
          const entry = deaths.get(deathId)
          if (!entry?.receipt) incident('Released a death without a committed receipt')
          if (entry?.released) incident('Released a death receipt twice')
          if (entry) entry.released = true
          count(stats, 'deathReceiptsReleased')
        },
        commitReward(intent) {
          const entry = deaths.get(intent.claim.deathId)
          if (!entry) incident('Reward worker processed no observed death')
          if (entry && entry.attempts++ > 0) count(stats, 'rewardRetries')
          const expected = allocateSoloExperience(baseExperience.get(intent.claim.spawnId) ?? 0, intent.groups)
          const previous = new Map(expected.map(({ characterId }) => [characterId, repository.read(characterId)]))
          let receipt
          try {
            receipt = memory.commitReward(intent)
          } catch (error) {
            count(stats, 'rewardError:' + (error.code ?? error.name))
            throw error
          }
          if (!entry) return receipt
          if (entry.receipt) {
            if (entry.receipt !== receipt) incident('Reward retry produced a new receipt')
            if ([...previous].some(([id, state]) => repository.read(id) !== state)) incident('Reward retry changed progression again')
            return receipt
          }
          entry.receipt = receipt
          pending--
          count(stats, 'rewardCommits')
          count(entry.room.events, 'rewardCommits')
          record(rewardLatency, performance.now() - entry.started)
          for (const recipient of receipt.recipients) {
            const before = previous.get(recipient.characterId)
            const after = repository.read(recipient.characterId)
            const allocated = expected.find(({ characterId }) => characterId === recipient.characterId)?.exp ?? 0
            if (recipient.experience > allocated || !after || (before && expTotal(after) - expTotal(before) !== recipient.experience)) {
              incident('Committed EXP differs from the aggregate or solo allocation')
            }
            if (recipient.experience && !before) incident('EXP granted outside allocated participants')
            count(stats, 'experience', recipient.experience)
          }
          for (const grant of receipt.grants) {
            if (grants.has(grant.lootId)) incident('Duplicate personal loot grant')
            if (
              !receipt.recipients.some(({ characterId }) => characterId === grant.ownerCharacterId) ||
              grant.expiresAtUtcMilliseconds !==
                receipt.committedAtUtcMilliseconds + initialEncounterRewardBalance.groundLootLifetimeMilliseconds
            ) {
              incident('Ground grant has invalid owner or expiry')
            }
            grants.set(grant.lootId, grant)
            count(stats, 'groundGrants')
            count(entry.room.events, 'groundGrants')
          }
          return receipt
        },
      }
    },
    wrapRepository(memory, ground) {
      const originalFind = memory.findReceipt
      readReceipt = originalFind
      const originalPick = ground.store.pick
      ground.store.pick = (delivery, ...rest) => {
        const result = originalPick(delivery, ...rest)
        if (result) {
          const { grant } = delivery
          if (!grants.has(grant.lootId) || picked.has(grant.lootId)) incident('Pickup had no unique committed ground grant')
          picked.add(grant.lootId)
          count(stats, 'picked:' + grant.content.kind)
        }
        return result
      }
      repository = {
        ...memory,
        findReceipt(characterId, key) {
          const receipt = originalFind(characterId, key)
          if (receipt) count(stats, 'receiptHits')
          return receipt
        },
        remove(characterId) {
          const entry = receipts.get(characterId)
          if (entry) {
            receiptCount -= entry.count
            receiptPayloadBytes -= entry.bytes
            count(stats, 'characterReceiptsReleased', entry.count)
            receipts.delete(characterId)
          }
          memory.remove(characterId)
        },
        commit(mutation, pickup) {
          const before = memory.read(mutation.characterId)
          const result = memory.commit(mutation, pickup)
          const after = memory.read(mutation.characterId)
          count(stats, 'mutation:' + result.kind)
          if (result.kind !== 'committed') {
            if (before !== after) incident('Uncommitted mutation changed the character')
            return result
          }
          const receipt = result.receipt
          const bytes = Buffer.byteLength(JSON.stringify(receipt))
          const entry = receipts.get(mutation.characterId) ?? { count: 0, bytes: 0 }
          entry.count++
          entry.bytes += bytes
          receiptCount++
          receiptPayloadBytes += bytes
          receipts.set(mutation.characterId, entry)
          count(stats, 'receipt:' + receipt.code)
          if (receipt.changed) count(stats, 'mutationsApplied')
          if (receipt.version !== after?.version || receipt.changed !== (before !== after)) {
            incident('Character mutation receipt does not match published state')
          }
          if (pickup && (!receipt.changed || !picked.has(pickup.grant.lootId)))
            incident('Pickup confirmed without atomic ground transition')
          if (
            pickup?.grant.content.kind === 'currency' &&
            after.inventory.currency - before.inventory.currency !== pickup.grant.content.amount
          ) {
            incident('Pickup currency was applied incorrectly')
          }
          if (pickup?.grant.content.kind === 'item') {
            const { itemDefinitionId, quantity } = pickup.grant.content
            const quantityIn = (state) =>
              state.inventory.bag.reduce((sum, item) => sum + (item?.itemDefinitionId === itemDefinitionId ? item.quantity : 0), 0)
            if (quantityIn(after) - quantityIn(before) !== quantity) incident('Pickup item quantity was applied incorrectly')
          }
          return result
        },
      }
      return repository
    },
    beginCommand(binding, payload, kind) {
      const key = JSON.stringify([binding.characterId, payload.requestEpoch ?? payload.connectionEpoch, payload.requestId])
      const command = { key, started: performance.now(), kind }
      if (!commands.has(key)) commands.set(key, command)
      commandPeak = Math.max(commandPeak, commands.size)
      return command
    },
    finishCommand(payload) {
      if (payload.code === 'PENDING') return
      const key = JSON.stringify([payload.characterId, payload.requestEpoch, payload.requestId])
      const command = commands.get(key)
      if (command) {
        commands.delete(key)
        record(mutationLatency, performance.now() - command.started)
      }
      if (
        payload.code === 'CONFIRMED' &&
        readReceipt(payload.characterId, JSON.stringify(['request', payload.requestEpoch, payload.requestId]))?.code !== 'CONFIRMED'
      ) {
        incident('Command confirmed without committed receipt')
      }
    },
    sample() {
      const now = Date.now()
      let groundActive = 0
      let groundExpired = 0
      for (const grant of grants.values()) {
        if (picked.has(grant.lootId)) continue
        if (grant.expiresAtUtcMilliseconds <= now) groundExpired++
        else groundActive++
      }
      return {
        stats,
        pending,
        pendingPeak,
        retainedDeathReceipts: (stats.rewardCommits ?? 0) - (stats.deathReceiptsReleased ?? 0),
        rewardLatency: distribution(rewardLatency),
        commandOutstanding: commands.size,
        commandPeak,
        mutationLatency: distribution(mutationLatency),
        receiptCount,
        receiptPayloadBytes,
        groundActive,
        groundExpired,
        groundPicked: picked.size,
        groundRecords: grants.size,
      }
    },
  }
}
