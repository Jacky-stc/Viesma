export type { WorldPoint } from '@viesma/domain'
export { PhysicsValidationError, type PhysicsErrorCode } from './errors.js'
export {
  isGridCoordinate,
  maxWorldCoordinate,
  positionQuantum,
  segmentIntersectsInterior,
  type Aabb,
  type PlatformCollider,
} from './geometry.js'
export { createSolidObstructionTest, createSolidPointSweep, type SolidObstructionTest, type SolidPointSweep } from './solid-point-sweep.js'
export {
  createPhysicsStepper,
  maxPhysicsSpeed,
  type PhysicsBody,
  type PhysicsConfig,
  type PhysicsInput,
  type PhysicsStepResult,
  type PhysicsStepper,
  type PhysicsVelocity,
  type PhysicsWorldDefinition,
} from './step.js'
