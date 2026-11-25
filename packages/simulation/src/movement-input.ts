import {
  isNonNegativeSafeInteger,
  toSimulationTick,
  type CharacterId,
  type MoveX,
  type NonNegativeSafeInteger,
  type SimulationTick,
} from '@viesma/domain'

export interface MovementButtons {
  readonly left: boolean
  readonly right: boolean
  readonly jump: boolean
}

export interface MovementInput {
  readonly moveX: MoveX
  readonly jumpPressed: boolean
}

export interface PlayerInputCommand extends MovementInput {
  readonly kind: 'input'
  readonly characterId: CharacterId
  readonly lifeStartedTick: SimulationTick
  readonly seq: NonNegativeSafeInteger
  readonly attackPressed?: boolean
}

export interface LocalMapInputCommand extends PlayerInputCommand {
  readonly mapEpoch: NonNegativeSafeInteger
  readonly portalPressed: boolean
  readonly npcInteraction?: NpcInteractionRequest
}

export type NpcInteractionRequest =
  | { readonly kind: 'toggle'; readonly npcId: string }
  | { readonly kind: 'close'; readonly npcId: string; readonly openedAtTick: SimulationTick }

export function normalizeMovementInput(buttons: MovementButtons, wasJumpDown: boolean): MovementInput {
  const { left, right, jump } = buttons
  const moveX = left === right ? 0 : left ? -1 : 1
  return { moveX, jumpPressed: jump && !wasJumpDown }
}

const commandFields = ['kind', 'characterId', 'lifeStartedTick', 'seq', 'moveX', 'jumpPressed'] as const
const mapCommandFields = [...commandFields, 'mapEpoch', 'portalPressed'] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactFields(value: object, fields: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))
}

function parseNpcInteraction(value: unknown): NpcInteractionRequest | undefined {
  if (!isPlainRecord(value)) return undefined
  const { kind, npcId, openedAtTick } = value
  if (typeof npcId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(npcId)) return undefined
  if (kind === 'toggle' && hasExactFields(value, ['kind', 'npcId'])) return { kind, npcId }
  if (kind === 'close' && hasExactFields(value, ['kind', 'npcId', 'openedAtTick']) && isNonNegativeSafeInteger(openedAtTick)) {
    return { kind, npcId, openedAtTick: toSimulationTick(openedAtTick || 0) }
  }
  return undefined
}

function parsePlayerInputCommand(
  value: unknown,
  expectedMapEpoch: NonNegativeSafeInteger | undefined
): LocalMapInputCommand | PlayerInputCommand | undefined {
  if (!isPlainRecord(value)) return undefined
  const hasNpcInteraction = expectedMapEpoch !== undefined && Object.hasOwn(value, 'npcInteraction')
  const hasAttack = Object.hasOwn(value, 'attackPressed')
  const fields: string[] = [...(expectedMapEpoch === undefined ? commandFields : mapCommandFields)]
  if (hasNpcInteraction) fields.push('npcInteraction')
  if (hasAttack) fields.push('attackPressed')
  if (!hasExactFields(value, fields)) return undefined
  const { kind, characterId, lifeStartedTick, seq: rawSeq, moveX, jumpPressed, attackPressed, mapEpoch, portalPressed } = value
  const seq = rawSeq === 0 ? 0 : rawSeq
  if (
    kind !== 'input' ||
    typeof characterId !== 'string' ||
    characterId.length === 0 ||
    !isNonNegativeSafeInteger(lifeStartedTick) ||
    !isNonNegativeSafeInteger(seq) ||
    (moveX !== -1 && moveX !== 0 && moveX !== 1) ||
    typeof jumpPressed !== 'boolean' ||
    (hasAttack && typeof attackPressed !== 'boolean')
  ) {
    return undefined
  }
  // 目標 ID 只在與 map 既有角色相符時才會套用。
  const command: PlayerInputCommand = {
    kind,
    characterId: characterId as CharacterId,
    lifeStartedTick: toSimulationTick(lifeStartedTick || 0),
    seq,
    moveX: moveX || 0,
    jumpPressed,
    ...(attackPressed === true && { attackPressed }),
  }
  if (expectedMapEpoch === undefined) return command
  if (mapEpoch !== expectedMapEpoch || typeof portalPressed !== 'boolean') return undefined
  const npcInteraction = hasNpcInteraction ? parseNpcInteraction(value.npcInteraction) : undefined
  if (hasNpcInteraction && !npcInteraction) return undefined
  return { ...command, mapEpoch: expectedMapEpoch, portalPressed, ...(npcInteraction && { npcInteraction }) }
}

function mapInputsMatch(current: LocalMapInputCommand, previous: LocalMapInputCommand): boolean {
  const left = current.npcInteraction
  const right = previous.npcInteraction
  return (
    current.portalPressed === previous.portalPressed &&
    left?.kind === right?.kind &&
    left?.npcId === right?.npcId &&
    (left?.kind !== 'close' || (right?.kind === 'close' && left.openedAtTick === right.openedAtTick))
  )
}

export interface SelectedInput {
  readonly command: PlayerInputCommand | LocalMapInputCommand
  readonly conflict: boolean
}

export function selectInputCommands(
  commands: readonly unknown[],
  playerLives: ReadonlyMap<CharacterId, SimulationTick>,
  mapEpoch?: NonNegativeSafeInteger
): ReadonlyMap<CharacterId, SelectedInput> {
  const selected = new Map<CharacterId, SelectedInput>()
  for (const value of commands) {
    const command = parsePlayerInputCommand(value, mapEpoch)
    if (command === undefined || command.lifeStartedTick !== playerLives.get(command.characterId)) continue
    const previous = selected.get(command.characterId)
    if (previous === undefined || command.seq > previous.command.seq) {
      selected.set(command.characterId, { command, conflict: false })
    } else if (
      command.seq === previous.command.seq &&
      (command.moveX !== previous.command.moveX ||
        command.jumpPressed !== previous.command.jumpPressed ||
        command.attackPressed !== previous.command.attackPressed ||
        ('portalPressed' in command && 'portalPressed' in previous.command && !mapInputsMatch(command, previous.command)))
    ) {
      selected.set(command.characterId, { command: previous.command, conflict: true })
    }
  }
  return selected
}
