export type PhysicsErrorCode =
  'INVALID_GEOMETRY' | 'INVALID_CONFIG' | 'INVALID_MOTION' | 'INVALID_TIMESTEP' | 'OUT_OF_BOUNDS' | 'INITIAL_OVERLAP'

export class PhysicsValidationError extends RangeError {
  readonly code: PhysicsErrorCode

  constructor(code: PhysicsErrorCode, message: string) {
    super(message)
    this.name = 'PhysicsValidationError'
    this.code = code
  }
}
