import type { MapPoint, NormalizedMap } from '@viesma/game-data'
import { Container, Sprite } from 'pixi.js'
import { facingScale, type PlayerVisualFrame } from '../player-view'
import { createBeginnerGraphics } from '../world-graphics'
import type { AtlasScope } from './atlas-scope'
import { visualIds } from './catalog'

interface BodySize {
  readonly width: number
  readonly height: number
}

export interface MonsterVisualFrame {
  readonly position: PlayerVisualFrame['position']
  readonly facing: PlayerVisualFrame['facing']
  readonly visualTick: number
  readonly archetypeId: string
}

const monsterVisualIds = new Map<string, string>(Object.entries(visualIds.monsters))

function drawSprite(sprite: Sprite, resolved: ReturnType<AtlasScope['resolve']>) {
  sprite.visible = resolved !== undefined
  if (resolved && sprite.texture !== resolved.texture) {
    sprite.texture = resolved.texture
    sprite.width = resolved.width
    sprite.height = resolved.height
  }
}

export function createBeginnerView(body: BodySize, assets: AtlasScope) {
  const root = new Container()
  const fallback = createBeginnerGraphics(body.width, body.height)
  const sprite = new Sprite({ anchor: { x: 0.5, y: 1 }, visible: false })
  root.addChild(fallback.root, sprite)
  assets.prepare(visualIds.beginner)
  let state: PlayerVisualFrame['state'] | undefined
  let startedAt = 0

  return {
    root,
    draw(frame: PlayerVisualFrame) {
      if (state !== frame.state) {
        state = frame.state
        startedAt = frame.visualTick
      }
      const visual = assets.resolve(visualIds.beginner, state, frame.visualTick - startedAt)
      drawSprite(sprite, visual)
      fallback.root.visible = !visual
      if (visual) {
        sprite.position.set(frame.position.x + body.width / 2, frame.position.y + body.height)
        sprite.scale.x = Math.abs(sprite.scale.x) * facingScale[frame.facing]
      } else {
        fallback.draw(frame)
      }
    },
  }
}

export function createSharedMonsterView(assets: AtlasScope) {
  const root = new Sprite({ anchor: { x: 0.5, y: 1 }, visible: false })
  return {
    root,
    draw(frame: MonsterVisualFrame): boolean {
      const id = monsterVisualIds.get(frame.archetypeId)
      if (id) assets.prepare(id)
      drawSprite(root, id ? assets.resolve(id, 'idle', frame.visualTick) : undefined)
      root.position.set(frame.position.x, frame.position.y)
      root.scale.x = Math.abs(root.scale.x) * facingScale[frame.facing]
      return root.visible
    },
  }
}

export function createMapSpriteView(map: NormalizedMap, assets: AtlasScope, body: BodySize, guide?: MapPoint) {
  const root = new Container()
  const sprites: { readonly id: string; readonly sprite: Sprite }[] = []

  function add(id: string, x: number, y: number) {
    assets.prepare(id)
    const sprite = new Sprite({ anchor: { x: 0.5, y: 1 }, visible: false })
    sprite.position.set(x, y)
    root.addChild(sprite)
    sprites.push({ id, sprite })
  }

  if (map.id === 'village') {
    const spawn = map.spawns.find(({ id }) => id === 'spawn_respawn')
    if (spawn) {
      const x = spawn.position.x + body.width / 2
      const y = spawn.position.y + body.height
      add(visualIds.trailTile, x + 58, y + 4)
    }
  }
  if (guide) add(visualIds.guide, guide.position.x, guide.position.y)
  for (const [archetypeId, id] of Object.entries(visualIds.monsters)) {
    const spawn = map.monsterSpawns.find(({ monsterArchetypeId }) => monsterArchetypeId === archetypeId)
    if (spawn) add(id, spawn.position.x, spawn.position.y)
  }
  const loot = map.lootFallbacks[0]
  if (loot) add(visualIds.loot, loot.position.x, loot.position.y)

  return {
    root,
    draw(ticks: number) {
      for (const { id, sprite } of sprites) drawSprite(sprite, assets.resolve(id, 'idle', ticks))
    },
    destroy() {
      root.destroy({ children: true })
      assets.destroy()
    },
  }
}
