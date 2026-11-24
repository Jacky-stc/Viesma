import type { GuideDefinition, NormalizedMap } from '@viesma/game-data'
import { Application, Container, type Graphics } from 'pixi.js'
import catalog from 'virtual:viesma-assets'
import { createAtlasScope } from './assets/atlas-scope'
import { indexSprites } from './assets/catalog'
import { createBeginnerView, createMapSpriteView, createSharedMonsterView, type MonsterVisualFrame } from './assets/sprite-views'
import { followCamera, type ViewportSize } from './camera'
import type { PlayerVisualFrame } from './player-view'
import { drawTerrain, worldColors } from './world-graphics'

const sprites = indexSprites(catalog)

interface PlayerSize {
  readonly width: number
  readonly height: number
}

export interface WorldRenderer {
  resetRoom(): void
  render(
    frame: PlayerVisualFrame & {
      readonly map: NormalizedMap
      readonly guide?: GuideDefinition | undefined
      readonly peers?: ReadonlyMap<string, PlayerVisualFrame>
      readonly monsters?: ReadonlyMap<string, MonsterVisualFrame>
    }
  ): void
}

export async function createWorldRenderer(
  host: HTMLElement,
  body: PlayerSize,
  signal: AbortSignal,
  diagnostics = false
): Promise<WorldRenderer | undefined> {
  if (signal.aborted) return undefined
  const app = new Application()
  let observer: ResizeObserver | undefined
  let disposed = false
  let releaseAssets: (() => void) | undefined

  function dispose() {
    if (disposed) return
    disposed = true
    signal.removeEventListener('abort', dispose)
    observer?.disconnect()
    releaseAssets?.()
    if (app.renderer) app.destroy({ removeView: true }, { children: true, context: true })
    else app.stage.destroy()
  }

  try {
    let size: ViewportSize = { width: host.clientWidth, height: host.clientHeight }
    let resolution = Math.min(window.devicePixelRatio, 2)
    const initialSize = { width: Math.max(1, size.width), height: Math.max(1, size.height) }
    await app.init({
      ...initialSize,
      resolution,
      autoDensity: true,
      antialias: true,
      autoStart: false,
      sharedTicker: false,
      preference: ['webgl'],
      backgroundColor: worldColors.surround,
      eventMode: 'none',
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    })
    if (signal.aborted) {
      dispose()
      return undefined
    }

    const terrain = new Container()
    const entityAssets = createAtlasScope(sprites, import.meta.env.BASE_URL)
    const player = createBeginnerView(body, entityAssets)
    const peers = new Container()
    const peerViews = new Map<string, ReturnType<typeof createBeginnerView>>()
    const monsters = new Container()
    const monsterViews = new Map<string, ReturnType<typeof createSharedMonsterView>>()
    let mapSprites: ReturnType<typeof createMapSpriteView> | undefined
    function clearRoomSprites() {
      for (const view of peerViews.values()) view.root.destroy({ children: true, context: true })
      for (const view of monsterViews.values()) view.root.destroy()
      peerViews.clear()
      monsterViews.clear()
    }
    releaseAssets = () => {
      mapSprites?.destroy()
      player.root.destroy({ children: true, context: true })
      clearRoomSprites()
      peers.destroy({ children: true, context: true })
      monsters.destroy({ children: true })
      if (diagnostics) {
        delete host.dataset.monsterSprites
        delete host.dataset.peerSprites
      }
      entityAssets.destroy()
    }
    terrain.addChild(monsters, peers, player.root)
    app.stage.addChild(terrain)

    app.canvas.setAttribute('role', 'img')
    app.canvas.setAttribute('aria-label', 'Beginner 平台場景')
    host.appendChild(app.canvas)
    observer = new ResizeObserver(([entry]) => {
      if (entry) size = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }
    })
    observer.observe(host)
    signal.addEventListener('abort', dispose, { once: true })

    let renderedSize: ViewportSize = initialSize
    let activeMap: NormalizedMap | undefined
    let mapGraphics: Graphics | undefined
    return {
      resetRoom: clearRoomSprites,
      render(frame) {
        if (disposed || size.width < 1 || size.height < 1) return
        const { map } = frame
        if (map !== activeMap) {
          const graphics = drawTerrain(map)
          mapGraphics?.destroy({ context: true })
          mapSprites?.destroy()
          terrain.addChildAt(graphics, 0)
          mapSprites = undefined
          if (!frame.peers) {
            mapSprites = createMapSpriteView(map, createAtlasScope(sprites, import.meta.env.BASE_URL), body, frame.guide?.npc)
            terrain.addChildAt(mapSprites.root, 1)
          }
          mapGraphics = graphics
          activeMap = map
        }
        const nextResolution = Math.min(window.devicePixelRatio, 2)
        if (size.width !== renderedSize.width || size.height !== renderedSize.height || nextResolution !== resolution) {
          app.renderer.resize(size.width, size.height, nextResolution)
          renderedSize = size
          resolution = nextResolution
        }

        const target = { x: frame.position.x + body.width / 2, y: frame.position.y + body.height / 2 }
        const camera = followCamera(target, map.bounds, size)
        terrain.scale.set(camera.scale)
        terrain.position.set(-camera.origin.x * camera.scale, -camera.origin.y * camera.scale)
        mapSprites?.draw(frame.visualTick)
        for (const [id, view] of monsterViews) {
          if (!frame.monsters?.has(id)) {
            view.root.destroy()
            monsterViews.delete(id)
          }
        }
        if (frame.monsters) {
          const visibleIds: string[] | undefined = diagnostics ? [] : undefined
          for (const [id, monster] of frame.monsters) {
            let view = monsterViews.get(id)
            if (!view) {
              view = createSharedMonsterView(entityAssets)
              monsterViews.set(id, view)
              monsters.addChild(view.root)
            }
            if (view.draw(monster)) visibleIds?.push(id)
          }
          if (visibleIds) {
            const spriteIds = visibleIds.join(',')
            if (host.dataset.monsterSprites !== spriteIds) host.dataset.monsterSprites = spriteIds
          }
        }
        for (const [id, view] of peerViews) {
          if (!frame.peers?.has(id)) {
            view.root.destroy({ children: true, context: true })
            peerViews.delete(id)
          }
        }
        for (const [id, peer] of frame.peers ?? []) {
          let view = peerViews.get(id)
          if (!view) {
            view = createBeginnerView(body, entityAssets)
            peerViews.set(id, view)
            peers.addChild(view.root)
          }
          view.draw(peer)
        }
        if (diagnostics && frame.peers) {
          const spriteCount = String(peerViews.size)
          if (host.dataset.peerSprites !== spriteCount) host.dataset.peerSprites = spriteCount
        }
        player.draw(frame)
        app.render()
      },
    }
  } catch (error) {
    dispose()
    throw error
  }
}
