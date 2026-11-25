import { maxCombatDamageEvents, parseCombatDamageBatch, type CombatDamage, type PublicMonster, type PublicPlayer } from '@viesma/protocol'

const damageDisplayMilliseconds = 800

interface VisibleDamage {
  readonly event: CombatDamage
  readonly startedAt: number
}

export function createCombatPresentation() {
  const active: VisibleDamage[] = []
  let room: string | undefined
  let firstTick = -1
  let latestTick = -1
  let latestId = 0
  let receivedCount = 0
  let players = new Map<string, PublicPlayer>()
  let monsters = new Map<string, PublicMonster>()

  function clear() {
    active.length = 0
    players.clear()
    monsters.clear()
    room = undefined
    firstTick = latestTick = -1
    latestId = receivedCount = 0
  }

  function isCurrent(event: CombatDamage) {
    if (event.kind === 'monster') {
      const monster = monsters.get(event.targetId)
      return monster?.generation === event.generation && monster.state !== 'respawnWait'
    }
    const player = players.get(event.targetId)
    return player?.lifeStartedTick === event.lifeStartedTick && player.mapEpoch === event.mapEpoch
  }

  return {
    snapshot(mapInstanceId: string, tick: number, publicPlayers: readonly PublicPlayer[], publicMonsters: readonly PublicMonster[]) {
      if (room !== undefined && room !== mapInstanceId) return
      if (tick <= latestTick) return
      room = mapInstanceId
      if (firstTick === -1) firstTick = tick
      latestTick = tick
      players = new Map(publicPlayers.map((player) => [player.characterId, player]))
      monsters = new Map(publicMonsters.map((monster) => [monster.monsterId, monster]))
      for (let index = active.length - 1; index >= 0; index--) {
        const effect = active[index]
        if (effect && !isCurrent(effect.event)) active.splice(index, 1)
      }
    },
    receive(payload: unknown, now: number) {
      const batch = parseCombatDamageBatch(payload)
      if (!batch || batch.mapInstanceId !== room || batch.serverTick !== latestTick) return
      for (const event of batch.events) {
        if (event.id <= latestId) continue
        latestId = event.id
        if (event.tick <= firstTick || !isCurrent(event)) continue
        active.push({ event, startedAt: now })
        receivedCount++
      }
      if (active.length > maxCombatDamageEvents) active.splice(0, active.length - maxCombatDamageEvents)
    },
    sample(now: number) {
      while (active[0] && now - active[0].startedAt >= damageDisplayMilliseconds) active.shift()
      return active.map(({ event, startedAt }) => ({ ...event, progress: (now - startedAt) / damageDisplayMilliseconds }))
    },
    receivedCount: () => receivedCount,
    clear,
  }
}
