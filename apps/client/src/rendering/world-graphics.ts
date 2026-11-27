import type { NormalizedMap } from '@viesma/game-data'
import type { PlayerPresentationState } from '@viesma/simulation'
import { Container, Graphics } from 'pixi.js'
import { facingScale, type PlayerVisualFrame } from './player-view'

export const worldColors = {
  surround: 0x0b1722,
  sky: 0x152b3a,
  grid: 0x254052,
  boundary: 0x527889,
  solid: 0x375469,
  solidEdge: 0x91afc4,
  oneWay: 0x245c5e,
  oneWayEdge: 0x68dbc1,
  portal: 0xffcc89,
}

export function drawTerrain(world: NormalizedMap, { showBackdrop = true, showGraybox = true, showBoundary = true } = {}): Graphics {
  const { origin, width, height } = world.bounds
  const { x, y } = origin
  const terrain = new Graphics()
  if (showBackdrop) {
    terrain.rect(x, y, width, height).fill(worldColors.sky)
    const gridStep = world.tileSizeWorldUnits * 2
    for (let gridX = x + gridStep; gridX < x + width; gridX += gridStep) {
      terrain
        .moveTo(gridX, y)
        .lineTo(gridX, y + height)
        .stroke({ color: worldColors.grid, width: 1 })
    }
    for (let gridY = y + gridStep; gridY < y + height; gridY += gridStep) {
      terrain
        .moveTo(x, gridY)
        .lineTo(x + width, gridY)
        .stroke({ color: worldColors.grid, width: 1 })
    }
  }
  for (const { kind, bounds } of showGraybox ? world.colliders : []) {
    const { x, y } = bounds.origin
    const fill = kind === 'oneWay' ? worldColors.oneWay : worldColors.solid
    const edge = kind === 'oneWay' ? worldColors.oneWayEdge : worldColors.solidEdge
    terrain
      .rect(x, y, bounds.width, bounds.height)
      .fill(fill)
      .moveTo(x, y)
      .lineTo(x + bounds.width, y)
      .stroke({ color: edge, width: 3 })
  }

  for (const { bounds } of world.portals) {
    const { x, y } = bounds.origin
    terrain
      .rect(x, y, bounds.width, bounds.height)
      .fill({ color: worldColors.portal, alpha: 0.18 })
      .stroke({ color: worldColors.portal, width: 2 })
  }

  if (showBoundary) terrain.rect(x + 1, y + 1, width - 2, height - 2).stroke({ color: worldColors.boundary, width: 2 })
  return terrain
}

export function drawCollisionOverlay(world: NormalizedMap) {
  const graphics = new Graphics()
  for (const { kind, bounds } of world.colliders) {
    const { x, y } = bounds.origin
    const color = kind === 'oneWay' ? worldColors.oneWayEdge : worldColors.solidEdge
    graphics.rect(x, y, bounds.width, bounds.height).fill({ color, alpha: 0.12 }).stroke({ color, width: 1.5 })
  }
  return graphics
}

const torsoColors = {
  idle: 0xffbc67,
  run: 0xffbc67,
  jump: 0xffd087,
  fall: 0xffd087,
  attack: 0xf9e7ae,
  hurt: 0xff8b91,
  death: 0x91afc4,
} satisfies Record<PlayerPresentationState, number>

export function createBeginnerGraphics(bodyWidth: number, bodyHeight: number) {
  const root = new Container()
  const figure = new Container()
  const outline = 0x0b1722
  const torso = new Graphics().roundRect(-10, -31, 20, 21, 5).fill(0xffffff).stroke({ width: 2, color: outline })
  const head = new Graphics()
    .roundRect(-9, -45, 18, 17, 5)
    .fill(0xffe1b9)
    .stroke({ width: 2, color: outline })
    .rect(3, -40, 3, 4)
    .fill(outline)
    .moveTo(-10, -43)
    .lineTo(-7, -48)
    .lineTo(4, -48)
    .lineTo(10, -43)
    .closePath()
    .fill(0x68453c)
    .stroke({ width: 2, color: outline })
  const rearFoot = new Graphics().roundRect(-11, -11, 9, 11, 2).fill(0x536178).stroke({ width: 2, color: outline })
  const frontFoot = new Graphics().roundRect(2, -11, 9, 11, 2).fill(0x8092a8).stroke({ width: 2, color: outline })
  const sword = new Graphics()
    .roundRect(0, -3, 28, 6, 3)
    .fill(0xffefd5)
    .stroke({ width: 2, color: outline })
    .rect(4, -6, 3, 12)
    .fill(0xca8e55)
  sword.position.set(6, -24)
  figure.addChild(rearFoot, frontFoot, torso, head, sword)
  root.addChild(figure)

  return {
    root,
    draw(frame: PlayerVisualFrame) {
      const { position, state, facing, visualTick } = frame
      const gait = state === 'run' ? Math.sin(visualTick * 0.72) : 0
      root.position.set(position.x + bodyWidth / 2, position.y + bodyHeight)
      root.scale.x = facingScale[facing]
      figure.rotation = state === 'death' ? -Math.PI / 2 : state === 'hurt' ? -0.2 : 0
      figure.position.set(state === 'death' ? 18 : 0, state === 'death' ? -10 : 0)
      torso.tint = torsoColors[state]
      rearFoot.position.set(4 * gait, -3 * Math.max(0, gait) - (state === 'jump' ? 2 : 0))
      frontFoot.position.set(-4 * gait + (state === 'fall' ? 3 : 0), 3 * Math.min(0, gait) - (state === 'jump' ? 5 : 0))
      sword.visible = state === 'attack'
      sword.rotation = Math.sin(visualTick * 0.5) * 0.65
    },
  }
}
