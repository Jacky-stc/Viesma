import { initialPhysicsBalance } from '@viesma/game-data'

export const balance = initialPhysicsBalance

export function box(x, y, width, height) {
  return { origin: { x, y }, width, height }
}

export function solid(x, y, width, height) {
  return { kind: 'solid', bounds: box(x, y, width, height) }
}

export function oneWay(x, y, width, height) {
  return { kind: 'oneWay', bounds: box(x, y, width, height) }
}

export function body(x, y, velocityY = 0) {
  return { bounds: box(x, y, balance.bodyWidthWorldUnits, balance.bodyHeightWorldUnits), velocity: { x: 0, y: velocityY } }
}

export function world(...colliders) {
  return { bounds: box(-256, -256, 768, 768), voidDepthWorldUnits: balance.voidDepthWorldUnits, colliders }
}
