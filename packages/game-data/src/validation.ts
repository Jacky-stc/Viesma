import { isNonNegativeSafeInteger } from '@viesma/domain'

export const maxContentInteger = 2_147_483_647
export const maxBasisPoints = 10_000

export type GameDataErrorCode =
  | 'UNSUPPORTED_SCHEMA'
  | 'UNSUPPORTED_TILED_FEATURE'
  | 'INVALID_TYPE'
  | 'INVALID_VALUE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_REFERENCE'
  | 'INVALID_REFERENCE'
  | 'OUT_OF_RANGE'
  | 'OVERFLOW'
  | 'INVALID_CURVE'

export class GameDataValidationError extends Error {
  readonly code: GameDataErrorCode
  readonly path: string

  constructor(code: GameDataErrorCode, path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'GameDataValidationError'
    this.code = code
    this.path = path
  }
}

export function invalid(code: GameDataErrorCode, path: string, message: string): never {
  throw new GameDataValidationError(code, path, message)
}

export function object(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) {
    invalid('INVALID_TYPE', path, 'Expected a plain object')
  }
  const prototype: unknown = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('INVALID_TYPE', path, 'Expected a plain object')
  }
  return input as Record<string, unknown>
}

export function fields(input: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const name of required) {
    if (!Object.hasOwn(input, name)) invalid('MISSING_FIELD', field(path, name), 'Required field')
  }
  for (const name of Object.keys(input)) {
    if (!required.includes(name) && !optional.includes(name)) {
      invalid('UNKNOWN_FIELD', field(path, name), 'Unknown field')
    }
  }
}

function field(path: string, name: string): string {
  return path === '$' ? name : `${path}.${name}`
}

export function record(input: unknown, path: string, required: readonly string[]): Record<string, unknown> {
  const result = object(input, path)
  fields(result, path, required)
  return result
}

export function array<T>(
  input: unknown,
  path: string,
  parse: (entry: unknown, entryPath: string) => T,
  minLength = 0,
  maxLength = maxContentInteger
): T[] {
  if (!Array.isArray(input)) invalid('INVALID_TYPE', path, 'Expected an array')
  if (input.length < minLength || input.length > maxLength) {
    invalid('OUT_OF_RANGE', path, `Expected between ${minLength} and ${maxLength} entries`)
  }
  return Array.from({ length: input.length }, (_, index) => parse(input[index], `${path}[${index}]`))
}

export function integer(input: unknown, path: string, min = 0, max = maxContentInteger): number {
  if (!isNonNegativeSafeInteger(input) || input < min || input > max) {
    invalid('OUT_OF_RANGE', path, `Expected an integer between ${min} and ${max}`)
  }
  return input === 0 ? 0 : input
}

export function id<Id extends string>(input: unknown, path: string): Id {
  if (typeof input !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input)) {
    invalid('INVALID_VALUE', path, 'Expected 1–64 lowercase ASCII ID characters (letters, digits, _ or -)')
  }
  return input as Id
}

export function name(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 80) {
    invalid('INVALID_VALUE', path, 'Expected a nonblank name of at most 80 characters')
  }
  return input
}

export function choice<const T extends string>(input: unknown, path: string, choices: readonly T[]): T {
  const match = choices.find((value) => value === input)
  if (match === undefined) invalid('INVALID_VALUE', path, `Expected one of: ${choices.join(', ')}`)
  return match
}

export function uniqueBy<T, Key extends string>(
  values: readonly T[],
  keyOf: (value: T) => Key,
  path: string,
  suffix = '.id'
): ReadonlyMap<Key, T> {
  const index = new Map<Key, T>()
  for (const [offset, value] of values.entries()) {
    const key = keyOf(value)
    if (index.has(key)) invalid('DUPLICATE_ID', `${path}[${offset}]${suffix}`, `Duplicate ID "${key}"`)
    index.set(key, value)
  }
  return index
}

export function reference<Key extends string, T>(index: ReadonlyMap<Key, T>, key: Key, path: string): T {
  const target = index.get(key)
  if (target === undefined) invalid('UNKNOWN_REFERENCE', path, `Unknown ID "${key}"`)
  return target
}

export function compareIds(left: string, right: string): number {
  return left < right ? -1 : Number(left > right)
}

export function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
