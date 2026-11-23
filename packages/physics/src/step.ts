import { fixedDeltaSeconds } from '@viesma/domain'
import { PhysicsValidationError } from './errors.js'
import {
  crossesFace,
  isGridCoordinate,
  maxWorldCoordinate,
  overlaps,
  prepareColliders,
  quantizePosition,
  readEdges,
  type Aabb,
  type Collider,
  type Edges,
  type PlatformCollider,
} from './geometry.js'

export const maxPhysicsSpeed = 2 ** 20
const maxGravityUnitsPerSecondSquared = 2 ** 20

export interface PhysicsConfig {
  readonly gravityUnitsPerSecondSquared: number
  readonly jumpSpeedUnitsPerSecond: number
  readonly terminalFallSpeedUnitsPerSecond: number
}

export interface PhysicsWorldDefinition {
  readonly bounds: Aabb
  readonly voidDepthWorldUnits: number
  readonly colliders: readonly PlatformCollider[]
}

/** 速度以 world units/s 表示。 */
export interface PhysicsVelocity {
  readonly x: number
  readonly y: number
}

export interface PhysicsBody {
  readonly bounds: Aabb
  readonly velocity: PhysicsVelocity
}

export interface PhysicsInput {
  readonly horizontalSpeedUnitsPerSecond: number
  readonly jumpPressed: boolean
  /** 控制器已驗證離開平台後仍在 coyote 視窗內。 */
  readonly allowCoyoteJump?: boolean
}

export interface PhysicsStepResult {
  readonly body: PhysicsBody
  readonly grounded: boolean
  readonly inVoid: boolean
}

export type PhysicsStepper = (body: PhysicsBody, input: PhysicsInput, dtSeconds: number) => PhysicsStepResult

interface AxisResult {
  readonly position: number
  readonly speed: number
}

function inspectStart(body: Edges, colliders: readonly Collider[]): boolean {
  let supported = false
  for (const collider of colliders) {
    if (!overlaps(body.left, body.right, collider.left, collider.right)) continue
    if (collider.kind === 'solid' && overlaps(body.top, body.bottom, collider.top, collider.bottom)) {
      throw new PhysicsValidationError('INITIAL_OVERLAP', 'Body starts inside a solid collider')
    }
    if (body.bottom === collider.top) supported = true
  }
  return supported
}

function sweepX(body: Edges, speed: number, world: Edges, colliders: readonly Collider[]): AxisResult {
  if (speed === 0) return { position: body.left, speed: 0 }

  const width = body.right - body.left
  const target = quantizePosition(body.left + speed * fixedDeltaSeconds)
  const rightLimit = world.right - width
  const movingRight = speed > 0
  let blocked = movingRight ? target >= rightLimit : target <= world.left
  let position = Math.min(rightLimit, Math.max(world.left, target))
  for (const collider of colliders) {
    if (collider.kind !== 'solid' || !overlaps(body.top, body.bottom, collider.top, collider.bottom)) continue
    const face = movingRight ? collider.left - width : collider.right
    if (crossesFace(body.left, position, face, movingRight)) {
      position = face
      blocked = true
    }
  }
  return { position, speed: blocked ? 0 : speed }
}

function sweepY(body: Edges, speed: number, world: Edges, colliders: readonly Collider[]): AxisResult {
  if (speed === 0) return { position: body.top, speed: 0 }

  const height = body.bottom - body.top
  const target = quantizePosition(body.top + speed * fixedDeltaSeconds)
  const falling = speed > 0
  let blocked = !falling && target <= world.top
  let position = Math.max(world.top, target)
  for (const collider of colliders) {
    if ((!falling && collider.kind === 'oneWay') || !overlaps(body.left, body.right, collider.left, collider.right)) continue
    // 掃掠從 tick 起點的 y 開始。下落時，腳底一開始已超過的平台面不會命中。
    const face = falling ? collider.top - height : collider.bottom
    if (crossesFace(body.top, position, face, falling)) {
      position = face
      blocked = true
    }
  }
  return { position, speed: blocked ? 0 : speed }
}

function isSupportedSpeed(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= maxPhysicsSpeed
}

export function createPhysicsStepper(definition: PhysicsWorldDefinition, config: PhysicsConfig): PhysicsStepper {
  const world = readEdges(definition?.bounds, 'world.bounds')
  const voidDepth = definition.voidDepthWorldUnits
  if (!isGridCoordinate(voidDepth) || voidDepth < 0) {
    throw new PhysicsValidationError('INVALID_GEOMETRY', 'Void depth must be a nonnegative supported grid coordinate')
  }
  const voidY = world.bottom + voidDepth
  if (!isGridCoordinate(voidY)) {
    throw new PhysicsValidationError('INVALID_GEOMETRY', 'Void plane exceeds the supported coordinate range')
  }
  const colliders = prepareColliders(definition.colliders, world)

  const gravity = config?.gravityUnitsPerSecondSquared
  const jumpSpeed = config?.jumpSpeedUnitsPerSecond
  const terminal = config?.terminalFallSpeedUnitsPerSecond
  if (
    !Number.isFinite(gravity) ||
    gravity < 0 ||
    gravity > maxGravityUnitsPerSecondSquared ||
    !isSupportedSpeed(jumpSpeed) ||
    jumpSpeed <= 0 ||
    !isSupportedSpeed(terminal) ||
    terminal <= 0
  ) {
    throw new PhysicsValidationError('INVALID_CONFIG', 'Gravity, jump speed and terminal speed must be in the supported range')
  }
  const gravityPerTick = gravity * fixedDeltaSeconds

  return (body, input, dtSeconds) => {
    if (dtSeconds !== fixedDeltaSeconds) {
      throw new PhysicsValidationError('INVALID_TIMESTEP', 'Physics requires exactly one fixed 30 Hz delta')
    }
    const speedX = input?.horizontalSpeedUnitsPerSecond
    const speedY = body?.velocity?.y
    if (
      !isSupportedSpeed(speedX) ||
      !isSupportedSpeed(speedY) ||
      !isSupportedSpeed(body?.velocity?.x) ||
      typeof input?.jumpPressed !== 'boolean' ||
      (input.allowCoyoteJump !== undefined && typeof input.allowCoyoteJump !== 'boolean')
    ) {
      throw new PhysicsValidationError('INVALID_MOTION', 'Body velocity and input must be within the supported range')
    }
    const start = readEdges(body.bounds, 'body.bounds')
    if (start.left < world.left || start.right > world.right || start.top < world.top) {
      throw new PhysicsValidationError('OUT_OF_BOUNDS', 'Body starts beyond a solid world boundary')
    }
    const supported = inspectStart(start, colliders)
    const jumping = input.jumpPressed && (supported || input.allowCoyoteJump === true) && speedY >= 0
    const fallSpeed = Math.min((jumping ? -jumpSpeed : speedY) + gravityPerTick, terminal)
    const { width, height } = body.bounds
    const horizontal = sweepX(start, speedX, world, colliders)
    const shifted = { ...start, left: horizontal.position, right: horizontal.position + width }
    const vertical = sweepY(shifted, fallSpeed, world, colliders)
    const bottom = vertical.position + height
    if (bottom > maxWorldCoordinate) {
      throw new PhysicsValidationError('OUT_OF_BOUNDS', 'Body would exceed the supported coordinate range')
    }
    const grounded =
      vertical.speed === 0 &&
      (fallSpeed > 0 ||
        colliders.some((collider) => bottom === collider.top && overlaps(shifted.left, shifted.right, collider.left, collider.right)))
    return {
      body: {
        bounds: { origin: { x: horizontal.position || 0, y: vertical.position || 0 }, width, height },
        velocity: { x: horizontal.speed, y: vertical.speed },
      },
      grounded,
      inVoid: bottom >= voidY,
    }
  }
}
