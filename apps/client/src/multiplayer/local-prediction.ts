import { isNonNegativeSafeInteger, toSimulationTick, type NonNegativeSafeInteger, type SimulationTick } from '@viesma/domain'
import { initialPhysicsBalance, type NormalizedMap } from '@viesma/game-data'
import { isGridCoordinate, maxPhysicsSpeed } from '@viesma/physics'
import { PROTOCOL_VERSION, type InputFrame, type MapRoomJoin, type MovementCheckpoint } from '@viesma/protocol'
import { createPlayerController, type PlayerControllerState } from '@viesma/simulation'
import { correctionPathIsClear, hardCorrectionWorldUnits } from './correction-presentation'

export const inputHistoryCapacity = 120
type MovementIntent = Pick<InputFrame, 'moveX' | 'jumpPressed' | 'attackPressed'>
type HistoryFrame = InputFrame & { readonly seq: NonNegativeSafeInteger }
interface PendingInput {
  readonly localTick: SimulationTick
  readonly frame: HistoryFrame
}

interface PredictedMovement {
  readonly tick: SimulationTick
  readonly controller: PlayerControllerState
}

export function createLocalPrediction(map: NormalizedMap, mapInstanceId: string, binding: MapRoomJoin) {
  const advanceController = createPlayerController(map)
  const pending: PendingInput[] = []
  let authority: MovementCheckpoint | undefined
  let predicted: PredictedMovement | undefined
  let lastSentSeq = 0
  let waitingForCheckpoint = true
  let disposed = false
  let lastCorrectionWorldUnits = 0
  let replayedInputs = 0
  let historyOverflows = 0

  function restore(checkpoint: MovementCheckpoint): PredictedMovement {
    return { tick: checkpoint.serverTick, controller: checkpoint.controller }
  }

  function advance(state: PredictedMovement, frame: HistoryFrame): PredictedMovement {
    const tick = toSimulationTick(state.tick + 1)
    // Attack edge 隨原幀保留。M1 開發房只接通移動，控制器沒有預測戰鬥事件。
    return { tick, controller: advanceController(state.controller, frame, undefined, tick) }
  }

  function suspend() {
    pending.length = 0
    waitingForCheckpoint = true
    predicted = authority && restore(authority)
  }

  return {
    get predicted() {
      return predicted
    },
    get ready() {
      return !waitingForCheckpoint && predicted?.controller.action.kind !== 'death'
    },
    get diagnostics() {
      return {
        pendingInputs: pending.length,
        ackInputSeq: authority?.ackInputSeq ?? null,
        lastCorrectionWorldUnits,
        replayedInputs,
        historyOverflows,
      }
    },
    receive(checkpoint: MovementCheckpoint): 'ignored' | 'reset' | 'snap' | 'reconciled' {
      const { mapEpoch, serverTick, lifeStartedTick, ackInputSeq, controller } = checkpoint
      if (
        disposed ||
        checkpoint.characterId !== binding.characterId ||
        checkpoint.connectionEpoch !== binding.connectionEpoch ||
        checkpoint.mapInstanceId !== mapInstanceId ||
        mapEpoch < (authority?.mapEpoch ?? binding.mapEpoch) ||
        serverTick <= (authority?.serverTick ?? -1) ||
        lifeStartedTick < (authority?.lifeStartedTick ?? 0) ||
        (authority?.controller.action.kind === 'death' &&
          lifeStartedTick === authority.lifeStartedTick &&
          controller.action.kind !== 'death') ||
        (ackInputSeq ?? -1) < (authority?.ackInputSeq ?? -1) ||
        (ackInputSeq !== null && ackInputSeq > lastSentSeq) ||
        !validControllerGeometry(controller)
      )
        return 'ignored'

      const reset =
        waitingForCheckpoint ||
        mapEpoch !== authority?.mapEpoch ||
        lifeStartedTick !== authority?.lifeStartedTick ||
        (controller.action.kind === 'death') !== (authority.controller.action.kind === 'death')

      if (reset) pending.length = 0
      else if (ackInputSeq !== null) {
        const firstOutstanding = pending.findIndex(({ frame }) => frame.seq > ackInputSeq)
        pending.splice(0, firstOutstanding === -1 ? pending.length : firstOutstanding)
      }
      const corrected = pending.reduce((state, { frame }) => advance(state, frame), restore(checkpoint))
      const before = predicted?.controller.position
      const after = corrected.controller.position
      lastCorrectionWorldUnits = before ? Math.hypot(before.x - after.x, before.y - after.y) : 0
      replayedInputs = pending.length
      authority = checkpoint
      predicted = corrected
      waitingForCheckpoint = false
      if (reset) return 'reset'
      return lastCorrectionWorldUnits > hardCorrectionWorldUnits ? 'snap' : 'reconciled'
    },
    step(intent: MovementIntent, localTick: SimulationTick): InputFrame | undefined {
      if (waitingForCheckpoint || !authority || !predicted || predicted.controller.action.kind === 'death') return undefined
      if (pending.length === inputHistoryCapacity) {
        historyOverflows++
        suspend()
        return undefined
      }
      const seq = lastSentSeq + 1
      if (!isNonNegativeSafeInteger(seq)) throw new RangeError('Local input sequence exhausted')
      const { moveX, jumpPressed, attackPressed } = intent
      const frame = {
        protocolVersion: PROTOCOL_VERSION,
        connectionEpoch: binding.connectionEpoch,
        mapEpoch: authority.mapEpoch,
        seq,
        moveX,
        jumpPressed,
        attackPressed,
      }
      pending.push({ localTick, frame })
      lastSentSeq = seq
      predicted = advance(predicted, frame)
      return frame
    },
    suspend,
    dispose() {
      disposed = true
      pending.length = 0
      authority = undefined
      predicted = undefined
      lastSentSeq = 0
      waitingForCheckpoint = true
      lastCorrectionWorldUnits = 0
      replayedInputs = 0
      historyOverflows = 0
    },
  }

  function validControllerGeometry({ position, physics }: PlayerControllerState): boolean {
    const { bodyWidthWorldUnits: width, bodyHeightWorldUnits: height } = initialPhysicsBalance
    return (
      isGridCoordinate(position.x) &&
      isGridCoordinate(position.y) &&
      isGridCoordinate(position.x + width) &&
      isGridCoordinate(position.y + height) &&
      Math.abs(physics.velocity.x) <= maxPhysicsSpeed &&
      Math.abs(physics.velocity.y) <= maxPhysicsSpeed &&
      correctionPathIsClear(map, position, position)
    )
  }
}
