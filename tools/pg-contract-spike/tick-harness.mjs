export function createTickHarness(characters) {
  const queued = []
  const delivered = []
  const inFlight = new Map()
  const events = []
  let tickCount = 0

  function record(kind, characterId, completion) {
    events.push({ kind, characterId, tick: tickCount, completion })
  }

  function deliver(completion) {
    delivered.push(completion)
  }

  async function execute(job) {
    const { characterId, repository, request, hooks } = job
    try {
      const result = await repository.execute(characterId, request, hooks)
      const state = result.kind === 'committed' && result.receipt.changed ? await repository.read(characterId) : undefined
      const completion = { job, state, version: result.receipt?.version }
      record('completed', characterId, completion)
      deliver(completion)
    } catch (error) {
      deliver({ job, error })
    }
  }

  return {
    events,
    deliver,
    get tickCount() {
      return tickCount
    },
    admit(characterId, repository, request, hooks) {
      const character = characters.get(characterId)
      if (!character || character.hp <= 0) return false
      queued.push({ characterId, repository, request, hooks })
      record('admitted', characterId)
      return true
    },
    tick() {
      tickCount += 1
      for (const completion of delivered.splice(0)) {
        const { job, state, version, error } = completion
        const { characterId } = job
        if (inFlight.get(characterId) === job) inFlight.delete(characterId)
        const character = characters.get(characterId)
        if (error) record('failed', characterId)
        if (!character || !state || version !== state.version || version <= character.version) continue
        // 只套用 durable economy 欄位。轉場路由與即時 HP／MP 由目前角色持有。
        character.version = version
        character.inventory = state.inventory
        record('applied', characterId, completion)
      }
      for (const job of queued.splice(0)) {
        if (inFlight.has(job.characterId)) {
          queued.push(job)
          continue
        }
        inFlight.set(job.characterId, job)
        record('dispatched', job.characterId)
        void execute(job)
      }
    },
  }
}
