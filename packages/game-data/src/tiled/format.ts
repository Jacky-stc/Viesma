import { isGridCoordinate } from '@viesma/physics'
import { array, fields, invalid, object } from '../validation.js'

export function tiledRecord(
  input: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  const value = object(input, path)
  fields(value, path, required, optional)
  return value
}

export function unsupported(path: string, message: string): never {
  return invalid('UNSUPPORTED_TILED_FEATURE', path, message)
}

export function defaultOnly(input: unknown, path: string, expected: string | number | boolean): void {
  if (input !== undefined && input !== expected) unsupported(path, `Expected default value ${JSON.stringify(expected)}`)
}

export function tiledVersion(value: Record<string, unknown>, path: string): void {
  for (const [key, pattern] of [
    ['version', /^1\.(10|11|12)$/],
    ['tiledversion', /^1\.(10|11|12)(\.\d+)?$/],
  ] as const) {
    const version = value[key]
    if (typeof version !== 'string' || !pattern.test(version)) {
      unsupported(`${path}.${key}`, 'Expected a Tiled 1.10–1.12 JSON export')
    }
  }
}

export function relativeAssetPath(input: unknown, path: string): string {
  if (typeof input !== 'string' || !/^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(input)) {
    invalid('INVALID_VALUE', path, 'Expected a relative slash-separated asset path without traversal')
  }
  return input
}

export function coordinate(input: unknown, path: string): number {
  if (typeof input !== 'number' || !isGridCoordinate(input)) {
    invalid('OUT_OF_RANGE', path, 'Expected a finite M1.1 grid coordinate (1/1024 world unit)')
  }
  return input || 0
}

export function boolean(input: unknown, path: string): boolean {
  if (typeof input !== 'boolean') invalid('INVALID_TYPE', path, 'Expected a boolean')
  return input
}

interface Property {
  readonly type: 'string' | 'float' | 'int'
  readonly value: unknown
  readonly path: string
}

export function properties(input: unknown, path: string): ReadonlyMap<string, Property> {
  const result = new Map<string, Property>()
  if (input === undefined) return result
  for (const { key, property } of array(input, path, (entry, entryPath) => {
    const value = tiledRecord(entry, entryPath, ['name', 'type', 'value'])
    if (typeof value.name !== 'string') invalid('INVALID_TYPE', `${entryPath}.name`, 'Expected a property name')
    if (value.type !== 'string' && value.type !== 'float' && value.type !== 'int') {
      unsupported(`${entryPath}.type`, 'Only string, float and int properties are supported')
    }
    if (value.type === 'int' && !Number.isInteger(value.value)) {
      invalid('INVALID_TYPE', `${entryPath}.value`, 'Expected an int property value')
    }
    return { key: value.name, property: { type: value.type, value: value.value, path: entryPath } } as const
  })) {
    if (result.has(key)) invalid('DUPLICATE_ID', `${property.path}.name`, `Duplicate property "${key}"`)
    result.set(key, property)
  }
  return result
}

export function propertyFields(values: ReadonlyMap<string, Property>, path: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (!values.has(key)) invalid('MISSING_FIELD', `${path}[${key}]`, `Missing property "${key}"`)
  }
  for (const [key, value] of values) {
    if (!keys.includes(key)) invalid('UNKNOWN_FIELD', `${value.path}.name`, `Unsupported property "${key}"`)
  }
}

export function property<T>(
  values: ReadonlyMap<string, Property>,
  path: string,
  key: string,
  types: readonly Property['type'][],
  parse: (input: unknown, path: string) => T
): T {
  const value = values.get(key)
  if (!value) invalid('MISSING_FIELD', `${path}[${key}]`, `Missing property "${key}"`)
  if (!types.includes(value.type)) invalid('INVALID_TYPE', `${value.path}.type`, `Expected type ${types.join(' or ')}`)
  return parse(value.value, `${value.path}.value`)
}
