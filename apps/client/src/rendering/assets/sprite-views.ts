import type { MapPoint, NormalizedMap } from '@viesma/game-data'
import type { PublicMonster } from '@viesma/protocol'
import { Container, Graphics, Sprite } from 'pixi.js'
import { characterPreviewModes, type CharacterPreviewOptions } from '../character-preview'
import { facingScale, type PlayerVisualFrame } from '../player-view'
import { createBeginnerGraphics } from '../world-graphics'
import type { AtlasScope } from './atlas-scope'
import { visualIds, type BeginnerIdlePose } from './catalog'
import { createPaperDollView, paperDollDiagnostics, type PaperDollLayers } from './paper-doll-view'

interface BodySize {
  readonly width: number
  readonly height: number
}

interface CharacterAnimationState {
  id: PlayerVisualFrame['state'] | undefined
  frameIndex: number
  playbackRate: number
  elapsedTicks: number
  facing: PlayerVisualFrame['facing']
}

export interface MonsterVisualFrame {
  readonly position: PlayerVisualFrame['position']
  readonly facing: PlayerVisualFrame['facing']
  readonly visualTick: number
  readonly archetypeId: string
  readonly state: PublicMonster['state']
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

export function createBeginnerView(
  body: BodySize,
  assets: AtlasScope,
  characterAssets?: AtlasScope,
  idlePose?: BeginnerIdlePose,
  faceLayers?: PaperDollLayers
) {
  const root = new Container()
  const fallback = createBeginnerGraphics(body.width, body.height)
  const sprite = new Sprite({ anchor: { x: 0.5, y: 1 }, visible: false })
  root.addChild(fallback.root, sprite)
  assets.prepare(visualIds.beginner)
  const animation: CharacterAnimationState = {
    id: undefined,
    frameIndex: 0,
    playbackRate: 1,
    elapsedTicks: 0,
    facing: 'left',
  }
  let startedAt = 0
  let collision: Graphics | undefined
  let footAnchor: Graphics | undefined
  let attachmentView: Graphics | undefined
  let attachmentPose: BeginnerIdlePose['frames'][number] | undefined
  let idleTick: number | undefined
  let paperDoll: ReturnType<typeof createPaperDollView> | undefined
  let neutralPose: BeginnerIdlePose['frames'][number] | undefined

  return {
    root,
    get appearance() {
      const doll = paperDoll?.root.visible ? paperDoll : undefined
      return {
        renderState: animation.id,
        facing: animation.facing,
        pose: doll ? (animation.id === 'idle' ? 'idle' : 'neutral') : sprite.visible ? 'single-sprite' : 'vector',
        frameIndex: doll ? animation.frameIndex : null,
        faceVisible: doll?.order.split(' → ').includes('face') ?? false,
        order: doll?.order ?? null,
        attachments: doll?.attachments ?? null,
      }
    },
    get layerOrder() {
      if (paperDoll?.root.visible) {
        const pose = animation.id === 'idle' ? `F${animation.frameIndex}` : 'Neutral'
        return `${pose} · ${paperDoll.order}`
      }
      return undefined
    },
    draw(frame: PlayerVisualFrame, preview?: CharacterPreviewOptions, facing = frame.facing) {
      if (animation.id !== frame.state) {
        animation.id = frame.state
        startedAt = frame.visualTick
      }
      animation.facing = facing
      const mode = preview && characterPreviewModes[preview.mode]
      const usePaperDoll = import.meta.env.DEV && preview?.mode === 'paper-doll'
      const animated = usePaperDoll || preview?.mode === 'animated-base-body'
      let idleTexture: ReturnType<AtlasScope['textureAt']>
      if (animated && idlePose && animation.id === 'idle') {
        const { speed, playing, frame: selected } = preview.idle
        const delta = Math.max(0, frame.visualTick - (idleTick ?? frame.visualTick))
        const { ticksPerFrame, frames } = idlePose
        animation.playbackRate = speed
        if (selected !== null) animation.elapsedTicks = selected * ticksPerFrame
        else if (playing) {
          animation.elapsedTicks = (animation.elapsedTicks + delta * animation.playbackRate) % (frames.length * ticksPerFrame)
        }
        idleTick = frame.visualTick
        animation.frameIndex = Math.floor(animation.elapsedTicks / ticksPerFrame)
        idleTexture = characterAssets?.textureAt(visualIds.beginnerIdle, animation.id, animation.frameIndex)
      } else {
        idleTick = undefined
        animation.elapsedTicks = 0
        animation.frameIndex = 0
      }
      const staticId = animated ? visualIds.beginnerBaseBody : mode?.spriteId
      const x = frame.position.x + body.width / 2
      const y = frame.position.y + body.height
      const idleIndex = animation.frameIndex
      const idleFrame = idlePose?.frames[idleIndex]
      const idleScale = idlePose && preview ? idlePose.worldUnitsPerPixel * (preview.height / 80) : 1
      const previewVisual = !idleTexture && staticId ? characterAssets?.resolve(staticId, 'idle', 0) : undefined
      const mirror = facingScale[animation.facing] * facingScale[(idleTexture || previewVisual) && mode ? mode.sourceFacing : 'right']
      const useNeutral = usePaperDoll && animation.id !== 'idle'
      const staticTexture = useNeutral ? previewVisual?.texture : undefined
      const neutralFrame = idlePose?.frames[0]
      if (staticTexture && idlePose && neutralFrame) {
        // 單格素體與 Idle 第零幀共用同一張中性畫姿，裁切原點由原有腳底對齊方式換算。
        neutralPose ??= {
          ...neutralFrame,
          offsetPx: { x: idlePose.pivotPx.x - staticTexture.width / 2, y: idlePose.pivotPx.y - staticTexture.height },
        }
      }
      // 單格素體尚未可用時沿用同像素的 Idle 第零格，固定於中性畫姿。
      const neutralTexture = useNeutral ? (staticTexture ?? characterAssets?.textureAt(visualIds.beginnerIdle, 'idle', 0)) : undefined
      const dollTexture = usePaperDoll ? (idleTexture ?? neutralTexture) : undefined
      const dollPose = idleTexture ? idleFrame : useNeutral ? (staticTexture ? neutralPose : neutralFrame) : undefined
      if (dollTexture && dollPose && idlePose && preview && characterAssets) {
        fallback.root.visible = false
        sprite.visible = false
        if (!paperDoll) {
          paperDoll = createPaperDollView(characterAssets, idlePose.pivotPx)
          root.addChildAt(paperDoll.root, 2)
        }
        const diagnostic = preview.showDiagnosticLayers ? paperDollDiagnostics[idleIndex] : undefined
        const showFace = !preview.showDiagnosticLayers && preview.showFace
        paperDoll.draw(
          dollPose,
          frame.state,
          idleIndex,
          dollTexture,
          (idleTexture && diagnostic?.order) || dollPose.drawOrder,
          diagnostic?.layers ?? (showFace ? faceLayers : undefined),
          x,
          y,
          idleScale,
          mirror,
          showFace && faceLayers ? preview.faceCalibration : undefined
        )
      } else if (idleTexture && idlePose && idleFrame) {
        if (paperDoll) paperDoll.root.visible = false
        fallback.root.visible = false
        sprite.visible = true
        sprite.texture = idleTexture
        sprite.anchor.set(
          (idlePose.pivotPx.x - idleFrame.offsetPx.x) / idleTexture.width,
          (idlePose.pivotPx.y - idleFrame.offsetPx.y) / idleTexture.height
        )
        sprite.position.set(x, y)
        sprite.scale.set(idleScale * mirror, idleScale)
      } else {
        if (paperDoll) paperDoll.root.visible = false
        const visual = previewVisual ?? assets.resolve(visualIds.beginner, frame.state, frame.visualTick - startedAt)
        drawSprite(sprite, visual)
        fallback.root.visible = !visual
        if (visual) {
          sprite.anchor.set(0.5, 1)
          if (previewVisual && preview) sprite.scale.set(preview.height / previewVisual.texture.height)
          sprite.position.set(x, y)
          sprite.scale.x = Math.abs(sprite.scale.x) * mirror
        } else {
          fallback.draw(facing === frame.facing ? frame : { ...frame, facing })
        }
      }
      if (preview?.showCollision && !collision) {
        collision = new Graphics()
        collision.rect(-body.width / 2, -body.height, body.width, body.height).stroke({ color: 0x63e9ff, width: 1 })
        root.addChild(collision)
      }
      if (preview?.showFootAnchor && !footAnchor) {
        footAnchor = new Graphics()
        footAnchor.moveTo(-5, 0).lineTo(5, 0).moveTo(0, -5).lineTo(0, 5).stroke({ color: 0xffe070, width: 1.5 })
        root.addChild(footAnchor)
      }
      if (collision) {
        collision.visible = preview?.showCollision === true
        collision.position.set(x, y)
      }
      if (footAnchor) {
        footAnchor.visible = preview?.showFootAnchor === true
        footAnchor.position.set(x, y)
      }
      const overlayPose = preview?.idle.showAttachments ? (dollPose ?? (idleTexture ? idleFrame : undefined)) : undefined
      const attachments = overlayPose?.attachments
      if (attachments && idlePose) {
        if (!attachmentView) {
          attachmentView = new Graphics()
          root.addChild(attachmentView)
        }
        if (attachmentPose !== overlayPose) {
          attachmentView.clear()
          for (const point of Object.values(attachments)) {
            const px = point.x - idlePose.pivotPx.x
            const py = point.y - idlePose.pivotPx.y
            const angle = (point.rotationDeg * Math.PI) / 180
            attachmentView
              .circle(px, py, 3)
              .fill(0xffe070)
              .moveTo(px, py)
              .lineTo(px + Math.cos(angle) * 10, py + Math.sin(angle) * 10)
              .stroke({ color: 0xffe070, width: 2 })
          }
          attachmentPose = overlayPose
        }
        attachmentView.position.set(x, y)
        attachmentView.scale.set(idleScale * mirror, idleScale)
        attachmentView.visible = true
      } else if (attachmentView) {
        attachmentView.visible = false
      }
    },
  }
}

export function createSharedMonsterView(assets: AtlasScope) {
  const root = new Sprite({ anchor: { x: 0.5, y: 1 }, visible: false })
  return {
    root,
    draw(frame: MonsterVisualFrame, hurt: boolean): boolean {
      const id = monsterVisualIds.get(frame.archetypeId)
      if (id) assets.prepare(id)
      const { state, position, facing, visualTick } = frame
      drawSprite(root, id && state !== 'respawnWait' ? assets.resolve(id, 'idle', state === 'dead' ? 0 : visualTick) : undefined)
      root.position.set(position.x, position.y)
      root.rotation = state === 'dead' ? -Math.PI / 2 : state === 'attack' ? 0.17 * facingScale[facing] : 0
      root.alpha = state === 'rewardPending' ? 0.55 : state === 'dead' ? 0.7 : 1
      root.tint = hurt ? 0xff9b94 : state === 'attack' ? 0xffbe79 : state === 'spawning' ? 0xbbffe5 : 0xffffff
      root.scale.x = Math.abs(root.scale.x) * facingScale[facing]
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
