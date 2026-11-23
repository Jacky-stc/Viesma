import { initialPhysicsBalance, type GuideDefinition } from '@viesma/game-data'
import { findOverlappingPortal, type GuideInteraction } from '@viesma/simulation'
import { attachBrowserInput } from '../input/browser-input'
import type { AuxiliaryAction } from '../input/input-state'
import type { PlayerPresentation } from '../rendering/player-view'
import { createWorldRenderer } from '../rendering/world-renderer'
import { createPlayground, mapNames, type DebugDamage } from './scene'

export type PlaygroundMode = 'interactive' | 'scripted'
export interface PlaygroundPresentation extends PlayerPresentation {
  readonly atSafeHubSpawn: boolean
  readonly mapName: string
  readonly nearPortal: boolean
  readonly guide: GuideDefinition | undefined
  readonly guideInteraction: GuideInteraction | null
  readonly canInteractWithGuide: boolean
}

export async function runPlayground(
  host: HTMLElement,
  surface: HTMLElement,
  mode: PlaygroundMode,
  publish: (presentation: PlaygroundPresentation) => void,
  publishActions: (actions: readonly AuxiliaryAction[]) => void,
  signal: AbortSignal,
  takeGuideClose: () => GuideInteraction | undefined,
  takeDebugDamage?: () => DebugDamage | undefined
) {
  const renderer = await createWorldRenderer(
    host,
    { width: initialPhysicsBalance.bodyWidthWorldUnits, height: initialPhysicsBalance.bodyHeightWorldUnits },
    signal
  )
  if (!renderer || signal.aborted) return

  const document = host.ownerDocument
  const input = mode === 'interactive' ? attachBrowserInput(surface, signal) : undefined
  let scene: ReturnType<typeof createPlayground> | undefined
  let lastPresentation: PlaygroundPresentation | undefined
  let interactiveMilliseconds = 0
  let previousVisibleFrame: number | undefined
  if (input) {
    document.addEventListener(
      'visibilitychange',
      () => {
        previousVisibleFrame = undefined
      },
      { signal }
    )
  }

  const draw = (nowMilliseconds: number) => {
    frameId = requestAnimationFrame(draw)
    let sceneMilliseconds = nowMilliseconds
    if (input) {
      if (document.hidden) return
      interactiveMilliseconds += nowMilliseconds - (previousVisibleFrame ?? nowMilliseconds)
      previousVisibleFrame = nowMilliseconds
      sceneMilliseconds = interactiveMilliseconds
    }
    scene ??= createPlayground(
      sceneMilliseconds,
      input && {
        sample: input.sample,
        clear: input.clear,
        publishActions,
        takeGuideClose,
        ...(takeDebugDamage && { takeDebugDamage }),
      }
    )
    const frame = scene.advance(sceneMilliseconds)
    renderer.render(frame)
    const { state, facing, vitals, position, map, atSafeHubSpawn, guide, guideInteraction, canInteractWithGuide } = frame
    const mapName = mapNames.get(map.id) ?? map.id
    const nearPortal = (state === 'idle' || state === 'run') && findOverlappingPortal(map, position) !== undefined
    if (
      state !== lastPresentation?.state ||
      facing !== lastPresentation.facing ||
      vitals.hp !== lastPresentation.vitals.hp ||
      vitals.maxHp !== lastPresentation.vitals.maxHp ||
      vitals.mp !== lastPresentation.vitals.mp ||
      vitals.maxMp !== lastPresentation.vitals.maxMp ||
      atSafeHubSpawn !== lastPresentation.atSafeHubSpawn ||
      mapName !== lastPresentation.mapName ||
      nearPortal !== lastPresentation.nearPortal ||
      guide !== lastPresentation.guide ||
      guideInteraction !== lastPresentation.guideInteraction ||
      canInteractWithGuide !== lastPresentation.canInteractWithGuide
    ) {
      lastPresentation = { state, facing, vitals, atSafeHubSpawn, mapName, nearPortal, guide, guideInteraction, canInteractWithGuide }
      publish(lastPresentation)
    }
  }
  let frameId = requestAnimationFrame(draw)
  signal.addEventListener('abort', () => cancelAnimationFrame(frameId), { once: true })
}
