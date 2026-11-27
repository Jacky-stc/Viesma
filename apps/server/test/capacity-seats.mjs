/** @typedef {import('../src/runtime/map-runtime.ts').MapRuntime} MapRuntime */

/**
 * @typedef {object} SeatMetrics
 * @property {Map<object, string>} connections
 * @property {Set<string>} disconnected
 * @property {Set<string>} incoming
 * @property {number} activePeak
 * @property {number} reservedPeak
 * @property {number} seatsPeak
 */

/**
 * @param {MapRuntime} runtime
 * @param {(message: string) => void} incident
 * @returns {SeatMetrics}
 */
export function observeSeats(runtime, incident) {
  /** @type {SeatMetrics} */
  const metrics = {
    connections: new Map(),
    disconnected: new Set(),
    incoming: new Set(),
    activePeak: 0,
    reservedPeak: 0,
    seatsPeak: 0,
  }
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
    if (connections.delete(socket) && characterId !== undefined) disconnected.add(characterId)
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
  return metrics
}
