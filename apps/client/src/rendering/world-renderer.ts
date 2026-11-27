import type { WorldPoint } from '@viesma/domain'
import type { GuideDefinition, NormalizedMap } from '@viesma/game-data'
import type { CombatDamage, GroundLootView } from '@viesma/protocol'
import { Application, Container, Graphics, Text, type WebGLRenderer } from 'pixi.js'
import catalog from 'virtual:viesma-assets'
import { createAtlasScope } from './assets/atlas-scope'
import { face01SpriteId, indexSprites, visualIds } from './assets/catalog'
import { diagnosticSpriteId, type PaperDollLayers } from './assets/paper-doll-view'
import { createBeginnerView, createMapSpriteView, createSharedMonsterView, type MonsterVisualFrame } from './assets/sprite-views'
import { followCamera, viewportScale, type ViewportSize } from './camera'
import { characterPreviewModes, type CharacterPreviewRef } from './character-preview'
import { experimentalMapParallax, forestForegroundBands, organicForestParallax } from './forest-parallax'
import { createForestTerrainView, type ForestRenderMode } from './forest-terrain'
import type { ParallaxLayer } from './parallax-layout'
import { createParallaxRenderer, type ParallaxStats } from './parallax-renderer'
import type { PlayerVisualFrame } from './player-view'
import { drawCollisionOverlay, drawTerrain, worldColors } from './world-graphics'

const sprites = indexSprites(catalog)

interface PlayerSize {
  readonly width: number
  readonly height: number
}

interface ParallaxPreviewView {
  readonly origin: WorldPoint
  readonly zoom: number
  readonly layers: readonly ParallaxLayer[]
  readonly mode: ForestRenderMode
  readonly showCollision: boolean
}

export interface WorldRenderer {
  resetRoom(): void
  parallaxStats(): ParallaxStats | undefined
  terrainStats(): { readonly decodedBytes: number; readonly cells: number } | undefined
  render(
    frame: PlayerVisualFrame & {
      readonly map: NormalizedMap
      readonly guide?: GuideDefinition | undefined
      readonly peers?: ReadonlyMap<string, PlayerVisualFrame>
      readonly monsters?: ReadonlyMap<string, MonsterVisualFrame>
      readonly damage?: readonly (CombatDamage & { readonly progress: number })[]
      readonly groundLoot?: ReadonlyMap<string, GroundLootView> | undefined
    },
    preview?: ParallaxPreviewView
  ): void
}

function drawLootIcon({ content }: GroundLootView) {
  const view = new Graphics()
  if (content.kind === 'currency') {
    view.circle(0, -9, 7).fill(0xffd166).stroke({ color: 0x7e4918, width: 2 })
    return view.circle(0, -9, 3).stroke({ color: 0x9b591d, width: 1 })
  }
  if (content.itemDefinitionId === 'hp_potion' || content.itemDefinitionId === 'mp_potion') {
    view
      .roundRect(-5, -15, 10, 13, 3)
      .fill(content.itemDefinitionId === 'hp_potion' ? 0xff697d : 0x75b8ff)
      .stroke({ color: 0x232948, width: 2 })
    return view.rect(-3, -18, 6, 4).fill(0xffe4b6)
  }
  return view.poly([0, -18, 8, -10, 0, -2, -8, -10]).fill(0xccf2bb).stroke({ color: 0x41634f, width: 2 })
}

export async function createWorldRenderer(
  host: HTMLElement,
  body: PlayerSize,
  signal: AbortSignal,
  {
    diagnostics = false,
    previewParallax = false,
    characterPreview,
  }: {
    readonly diagnostics?: boolean
    readonly previewParallax?: boolean
    readonly characterPreview?: CharacterPreviewRef | undefined
  } = {}
): Promise<WorldRenderer | undefined> {
  if (signal.aborted) return undefined
  const app = new Application<WebGLRenderer>()
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

    const geometry = new Container()
    const actors = new Container()
    const experiment = import.meta.env.DEV ? new URLSearchParams(host.ownerDocument.location.search).get('parallax') : null
    const gameplayForestMode = experiment === '1' ? 'organic' : experiment === 'rectangular' ? 'rectangular' : 'graybox'
    const parallax = (() => {
      if (!import.meta.env.DEV || (!previewParallax && gameplayForestMode === 'graybox')) {
        return undefined
      }
      const { gl } = app.renderer
      const maxTextureSize: number = gl.getParameter(gl.MAX_TEXTURE_SIZE)
      const supported = catalog.experimentalParallax?.filter(({ width, height }) => width <= maxTextureSize && height <= maxTextureSize)
      return createParallaxRenderer(supported ?? [], import.meta.env.BASE_URL)
    })()
    const entityAssets = createAtlasScope(sprites, import.meta.env.BASE_URL)
    const characterAssets =
      import.meta.env.DEV && characterPreview ? createAtlasScope(sprites, import.meta.env.BASE_URL, undefined, 'linear') : undefined
    const idlePose = characterAssets ? sprites.get(visualIds.beginnerIdle)?.sprite.idlePose : undefined
    const appearanceDiagnostics =
      import.meta.env.DEV &&
      characterPreview &&
      new URLSearchParams(host.ownerDocument.location.search).get('appearanceDiagnostics') === '1'
    const face = import.meta.env.DEV && characterAssets ? sprites.get(face01SpriteId)?.sprite.attachedFace : undefined
    const faceLayers: PaperDollLayers | undefined = face
      ? { face: { kind: 'attached', spriteId: face01SpriteId, attachment: 'face', originPx: face.originPx } }
      : undefined
    const player = createBeginnerView(body, entityAssets, characterAssets, idlePose, faceLayers)
    const peers = new Container()
    const peerViews = new Map<string, ReturnType<typeof createBeginnerView>>()
    const monsters = new Container()
    const monsterViews = new Map<string, ReturnType<typeof createSharedMonsterView>>()
    const damageLayer = new Container()
    const damageViews = new Map<number, Text>()
    const lootLayer = new Container()
    let visibleLoot: ReadonlyMap<string, GroundLootView> | undefined
    let mapSprites: ReturnType<typeof createMapSpriteView> | undefined
    let mapTerrain: ReturnType<typeof createForestTerrainView> | undefined
    let collisionOverlay: Graphics | undefined
    function clearRoomSprites() {
      for (const view of peerViews.values()) view.root.destroy({ children: true, context: true })
      for (const view of monsterViews.values()) view.root.destroy()
      for (const view of damageViews.values()) view.destroy()
      peerViews.clear()
      monsterViews.clear()
      damageViews.clear()
      for (const view of lootLayer.removeChildren()) view.destroy({ context: true })
      visibleLoot = undefined
      if (diagnostics) delete host.dataset.groundLootSprites
    }
    releaseAssets = () => {
      mapSprites?.destroy()
      mapTerrain?.destroy()
      if (parallax) {
        parallax.destroy()
        delete host.dataset.parallaxLayers
        delete host.dataset.parallaxTextures
        delete host.dataset.terrainCells
      }
      player.root.destroy({ children: true, context: true })
      clearRoomSprites()
      peers.destroy({ children: true, context: true })
      monsters.destroy({ children: true })
      damageLayer.destroy({ children: true })
      lootLayer.destroy({ children: true })
      if (diagnostics) {
        delete host.dataset.monsterSprites
        delete host.dataset.peerSprites
        delete host.dataset.combatDamageSprites
        delete host.dataset.combatDamageLabels
      }
      characterAssets?.destroy()
      if (import.meta.env.DEV) delete host.dataset.paperDollOrder
      if (appearanceDiagnostics) delete host.dataset.appearance
      entityAssets.destroy()
    }
    actors.addChild(monsters, peers, player.root, lootLayer, damageLayer)
    if (parallax) app.stage.addChild(parallax.background, geometry, parallax.foreground, actors)
    else app.stage.addChild(geometry, actors)

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
    let activeForestMode: ForestRenderMode = 'graybox'
    let mapGraphics: Graphics | undefined
    let foregroundBands: ReturnType<typeof forestForegroundBands>
    let hasParallaxBackdrop = false
    let hasTerrainArt = false
    return {
      resetRoom: clearRoomSprites,
      parallaxStats: () => parallax?.stats(),
      terrainStats: () => mapTerrain?.stats(),
      render(frame, preview) {
        if (disposed || size.width < 1 || size.height < 1) return
        const character = import.meta.env.DEV ? characterPreview?.current : undefined
        const characterSpriteId = character && characterPreviewModes[character.mode].spriteId
        if (characterSpriteId) characterAssets?.prepare(characterSpriteId)
        if (character?.mode === 'animated-base-body' || character?.mode === 'paper-doll')
          characterAssets?.prepare(visualIds.beginnerBaseBody)
        if (import.meta.env.DEV && character?.mode === 'paper-doll') {
          if (character.showDiagnosticLayers) characterAssets?.prepare(diagnosticSpriteId, true)
          else if (character.showFace && faceLayers) characterAssets?.prepare(face01SpriteId, true)
        }
        const { map } = frame
        const mapChanged = map !== activeMap
        const forestMode = import.meta.env.DEV && map.id === 'm1' && parallax ? (preview?.mode ?? gameplayForestMode) : 'graybox'
        const modeChanged = forestMode !== activeForestMode
        if (mapChanged) {
          mapSprites?.destroy()
          mapSprites = undefined
          collisionOverlay?.destroy({ context: true })
          collisionOverlay = undefined
          if (!frame.peers) {
            mapSprites = createMapSpriteView(map, createAtlasScope(sprites, import.meta.env.BASE_URL), body, frame.guide?.npc)
            actors.addChildAt(mapSprites.root, 0)
          }
          activeMap = map
        }
        if (import.meta.env.DEV && (mapChanged || modeChanged)) {
          mapTerrain?.destroy()
          mapTerrain = undefined
          activeForestMode = forestMode
          foregroundBands = forestMode === 'rectangular' ? forestForegroundBands(map) : undefined
          if (forestMode !== 'graybox') {
            const assets = createAtlasScope(sprites, import.meta.env.BASE_URL, undefined, forestMode === 'organic' ? 'linear' : 'nearest')
            mapTerrain = createForestTerrainView(map, assets, forestMode)
            geometry.addChildAt(mapTerrain.root, 0)
          }
        }
        const nextResolution = Math.min(window.devicePixelRatio, 2)
        if (size.width !== renderedSize.width || size.height !== renderedSize.height || nextResolution !== resolution) {
          app.renderer.resize(size.width, size.height, nextResolution)
          renderedSize = size
          resolution = nextResolution
        }

        const target = { x: frame.position.x + body.width / 2, y: frame.position.y + body.height / 2 }
        const camera =
          preview && parallax
            ? { origin: preview.origin, scale: viewportScale(size) * preview.zoom }
            : followCamera(target, map.bounds, size)
        let backdrop = false
        const terrainArt = mapTerrain?.prepare() === true
        if (mapTerrain) mapTerrain.root.visible = terrainArt
        if (parallax) {
          const layers =
            forestMode === 'graybox'
              ? undefined
              : (preview?.layers ?? (forestMode === 'organic' ? organicForestParallax : experimentalMapParallax.get(map.id)))
          parallax.setLayers(layers, foregroundBands)
          backdrop = parallax.render(map.bounds, camera, size)
          if (!preview) {
            const { displayObjects, loaded } = parallax.stats()
            if (host.dataset.parallaxLayers !== String(displayObjects)) host.dataset.parallaxLayers = String(displayObjects)
            if (host.dataset.parallaxTextures !== String(loaded)) host.dataset.parallaxTextures = String(loaded)
            const terrainCells = String(mapTerrain?.stats().cells ?? 0)
            if (host.dataset.terrainCells !== terrainCells) host.dataset.terrainCells = terrainCells
          }
        }
        if (mapChanged || modeChanged || backdrop !== hasParallaxBackdrop || terrainArt !== hasTerrainArt) {
          hasParallaxBackdrop = backdrop
          hasTerrainArt = terrainArt
          mapGraphics?.destroy({ context: true })
          mapGraphics = drawTerrain(map, {
            showBackdrop: !backdrop,
            showGraybox: !terrainArt,
            showBoundary: forestMode !== 'organic' || !terrainArt,
          })
          geometry.addChildAt(mapGraphics, 0)
        }
        if (parallax && preview?.showCollision && !collisionOverlay) {
          collisionOverlay = drawCollisionOverlay(map)
          geometry.addChild(collisionOverlay)
        }
        if (collisionOverlay) collisionOverlay.visible = preview?.showCollision === true
        const sceneX = -camera.origin.x * camera.scale
        const sceneY = -camera.origin.y * camera.scale
        geometry.scale.set(camera.scale)
        geometry.position.set(sceneX, sceneY)
        actors.scale.set(camera.scale)
        actors.position.set(sceneX, sceneY)
        mapSprites?.draw(frame.visualTick)
        if (visibleLoot !== frame.groundLoot) {
          visibleLoot = frame.groundLoot
          for (const view of lootLayer.removeChildren()) view.destroy({ context: true })
          const stacks = new Map<string, number>()
          for (const item of visibleLoot?.values() ?? []) {
            const { x, y } = item.position
            const anchor = `${x},${y}`
            const index = stacks.get(anchor) ?? 0
            stacks.set(anchor, index + 1)
            const view = drawLootIcon(item)
            view.position.set(x, y - index * 16)
            lootLayer.addChild(view)
          }
          if (diagnostics) host.dataset.groundLootSprites = String(lootLayer.children.length)
        }
        const damageIds = new Set<number>()
        const hurtMonsters = new Set<string>()
        for (const hit of frame.damage ?? []) {
          damageIds.add(hit.id)
          if (hit.kind === 'monster' && hit.progress < 0.2) hurtMonsters.add(hit.targetId)
          let view = damageViews.get(hit.id)
          if (!view) {
            view = new Text({
              text: String(hit.amount),
              anchor: 0.5,
              style: { fontSize: 20, fontWeight: 'bold', fill: hit.critical ? 0xffdb75 : 0xffffff, stroke: { color: 0x2c1c21, width: 3 } },
            })
            damageViews.set(hit.id, view)
            damageLayer.addChild(view)
          }
          view.position.set(hit.x + (hit.kind === 'player' ? body.width / 2 : 0), hit.y - 22 - 32 * hit.progress)
          view.alpha = Math.min(1, 2 * (1 - hit.progress))
        }
        for (const [id, view] of damageViews) {
          if (damageIds.has(id)) continue
          view.destroy()
          damageViews.delete(id)
        }
        if (diagnostics && frame.damage) {
          const visibleDamage = [...damageViews.keys()].join(',')
          const damageLabels = [...damageViews].map(([id, view]) => `${id}:${view.text}`).join(',')
          if (host.dataset.combatDamageSprites !== visibleDamage) host.dataset.combatDamageSprites = visibleDamage
          if (host.dataset.combatDamageLabels !== damageLabels) host.dataset.combatDamageLabels = damageLabels
        }
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
            if (view.draw(monster, hurtMonsters.has(id))) visibleIds?.push(id)
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
            view = createBeginnerView(body, entityAssets, characterAssets, idlePose, faceLayers)
            peerViews.set(id, view)
            peers.addChild(view.root)
          }
          view.draw(peer, character)
        }
        if (diagnostics && frame.peers) {
          const spriteCount = String(peerViews.size)
          if (host.dataset.peerSprites !== spriteCount) host.dataset.peerSprites = spriteCount
        }
        player.draw(frame, character, character && character.facing !== 'gameplay' ? character.facing : frame.facing)
        if (appearanceDiagnostics) {
          const sample = JSON.stringify({
            mode: character?.mode,
            faceTextureAvailable: Boolean(characterAssets?.textureAt(face01SpriteId, 'idle', 0)),
            local: player.appearance,
            remote: [...peerViews.values()].map((view) => view.appearance),
          })
          if (host.dataset.appearance !== sample) host.dataset.appearance = sample
        }
        if (import.meta.env.DEV && characterPreview) {
          const order = character?.mode === 'paper-doll' && character.showLayerOrder ? player.layerOrder : undefined
          if (order !== host.dataset.paperDollOrder) {
            if (order === undefined) delete host.dataset.paperDollOrder
            else host.dataset.paperDollOrder = order
          }
        }
        app.render()
      },
    }
  } catch (error) {
    dispose()
    throw error
  }
}
