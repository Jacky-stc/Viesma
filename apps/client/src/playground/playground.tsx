import type { GuideInteraction } from '@viesma/simulation'
import { useEffect, useRef, useState } from 'react'
import { touchControls } from '../input/browser-input'
import type { AuxiliaryAction } from '../input/input-state'
import type { MultiplayerPresentation } from '../multiplayer/run-multiplayer'
import { runPlayground, type PlaygroundMode, type PlaygroundPresentation } from './run-playground'
import type { DebugDamage } from './scene'

type Mode = PlaygroundMode | 'multiplayer'

const stateLabels = {
  idle: '待機',
  run: '跑步',
  jump: '跳躍',
  fall: '下墜',
  attack: '攻擊',
  hurt: '受擊',
  death: '倒地',
} satisfies Record<PlaygroundPresentation['state'], string>

const actionLabels = {
  interact: '互動',
  pickup: '拾取',
  hpPotion: 'HP 藥水',
  mpPotion: 'MP 藥水',
  inventory: '物品欄',
  party: '隊伍',
  ap: '能力點數',
} satisfies Record<AuxiliaryAction, string>

export function Playground() {
  const hostRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLElement>(null)
  const helpRef = useRef<HTMLDialogElement>(null)
  const startup = useRef(Promise.resolve())
  const pendingDebugDamage = useRef<DebugDamage>(undefined)
  const pendingGuideClose = useRef<GuideInteraction>(undefined)
  const [active, setActive] = useState(true)
  const [mode, setMode] = useState<Mode>('interactive')
  const [presentation, setPresentation] = useState<PlaygroundPresentation>()
  const [multiplayer, setMultiplayer] = useState<MultiplayerPresentation>()
  const [actions, setActions] = useState<readonly AuxiliaryAction[]>([])
  const [failed, setFailed] = useState(false)
  const interactive = active && mode === 'interactive'
  const online = active && mode === 'multiplayer'
  const controlsReady = (interactive && presentation) || (online && multiplayer && !failed)
  const guide = presentation?.guide
  const guideInteraction = presentation?.guideInteraction

  useEffect(() => {
    const host = hostRef.current
    const surface = surfaceRef.current
    if (!active || !host || !surface) return

    const controller = new AbortController()
    const failedStartup = () => {
      if (!controller.signal.aborted) {
        controller.abort()
        setFailed(true)
      }
    }
    const takeGuideClose = () => {
      const close = pendingGuideClose.current
      pendingGuideClose.current = undefined
      return close
    }
    const takeDebugDamage =
      import.meta.env.DEV && mode === 'interactive'
        ? () => {
            const damage = pendingDebugDamage.current
            pendingDebugDamage.current = undefined
            return damage
          }
        : undefined
    // StrictMode 重跑 effect 時，先等前一次 init 結束並清理同一個容器。
    startup.current = startup.current
      .then(async () => {
        if (mode === 'multiplayer') {
          const { runMultiplayer } = await import('../multiplayer/run-multiplayer')
          return runMultiplayer(host, surface, setMultiplayer, failedStartup, controller.signal)
        }
        return runPlayground(host, surface, mode, setPresentation, setActions, controller.signal, takeGuideClose, takeDebugDamage)
      })
      .catch(failedStartup)
    return () => controller.abort()
  }, [active, mode])

  function resetStatus() {
    pendingDebugDamage.current = undefined
    pendingGuideClose.current = undefined
    setPresentation(undefined)
    setMultiplayer(undefined)
    setActions([])
    setFailed(false)
  }

  function toggleScene() {
    resetStatus()
    setActive(!active)
  }

  return (
    <main className="playground">
      <header className="playground-header">
        <div>
          <h1>Viesma</h1>
          <p aria-label="目前地圖">{(online ? multiplayer?.mapName : presentation?.mapName) ?? 'Beginner 平台測試場'}</p>
          {interactive && presentation?.nearPortal && <p>按 ↑／W 或點觸控 ↑ 進入傳送門</p>}
          {interactive && presentation?.canInteractWithGuide && !guideInteraction && <p>按 E 或點觸控「互動」與 Guide 對話</p>}
        </div>
        <div className="playground-toolbar">
          <select
            aria-label="場景模式"
            value={mode}
            onChange={(event) => {
              resetStatus()
              const value = event.target.value
              setMode(value === 'scripted' || value === 'multiplayer' ? value : 'interactive')
            }}
          >
            <option value="interactive">互動操作</option>
            <option value="scripted">腳本播放</option>
            <option value="multiplayer">多人測試</option>
          </select>
          <button
            type="button"
            onClick={() => helpRef.current?.showModal()}
          >
            操作說明
          </button>
          <button
            type="button"
            onClick={toggleScene}
          >
            {active ? '卸載場景' : '載入場景'}
          </button>
        </div>
      </header>
      <section
        className="playground-scene"
        aria-label="平台測試場"
        tabIndex={controlsReady ? 0 : undefined}
        ref={surfaceRef}
      >
        <div
          className="playground-canvas"
          ref={hostRef}
          onPointerDown={controlsReady ? () => surfaceRef.current?.focus({ preventScroll: true }) : undefined}
        />
        {guide && guideInteraction && (
          <section
            className="playground-guide"
            role="dialog"
            aria-labelledby="playground-guide-title"
          >
            <header>
              <h2 id="playground-guide-title">{guide.title}</h2>
              <button
                type="button"
                onClick={() => {
                  pendingGuideClose.current = guideInteraction
                  surfaceRef.current?.focus({ preventScroll: true })
                }}
              >
                關閉
              </button>
            </header>
            <ul
              aria-label="Guide 教學"
              tabIndex={0}
            >
              {guide.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        {(interactive || online) && (
          <>
            <div
              className="playground-touch"
              role="group"
              aria-label="觸控操作"
              hidden={!controlsReady}
            >
              <div className="playground-directions">
                {touchControls.slice(0, online ? 2 : 3).map(({ control, label, text }) => (
                  <button
                    key={control}
                    type="button"
                    data-input-control={control}
                    aria-label={label}
                  >
                    {text}
                  </button>
                ))}
              </div>
              <div className="playground-actions">
                {touchControls.slice(3, online ? 4 : undefined).map(({ control, label, text }) => (
                  <button
                    key={control}
                    type="button"
                    data-input-control={control}
                    aria-label={label}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
            {controlsReady && <p className="playground-rotate">請將裝置轉為橫向以操作。</p>}
          </>
        )}
        {(!active || failed || !(online ? multiplayer : presentation)) && (
          <p
            className="playground-status"
            role={failed ? 'alert' : 'status'}
          >
            {failed
              ? online
                ? '多人場景已中斷或無法啟動，請確認本機伺服器與 WebGL 後重新載入。'
                : '無法啟動場景，請確認瀏覽器支援 WebGL。'
              : online
                ? '連線至 M1…'
                : active
                  ? '載入場景中…'
                  : '場景已卸載'}
          </p>
        )}
      </section>
      <dialog
        className="playground-help"
        aria-labelledby="playground-help-title"
        ref={helpRef}
      >
        <h2 id="playground-help-title">操作說明</h2>
        <p>點一下場景或用 Tab 移入焦點，再使用以下按鍵。</p>
        {mode === 'multiplayer' ? (
          <p>可使用 ←／A、→／D 與 Space 移動及跳躍。手機橫向顯示觸控按鈕。</p>
        ) : (
          <>
            <ul>
              <li>移動 ←／A、→／D</li>
              <li>站在傳送門內，按 ↑／W 或觸控 ↑ 傳送</li>
              <li>跳躍 Space、攻擊 J</li>
              <li>靠近 Guide 時，按 E 或觸控「互動」開關對話</li>
              <li>拾取 F、HP／MP 藥水 1／2</li>
              <li>物品欄 I、隊伍 P、能力點數 K</li>
            </ul>
            <p>手機請橫向握持，可用不同手指同時移動與跳躍或攻擊。</p>
            <p>攻擊會播放測試動作。拾取、藥水和面板鍵會顯示已收到的輸入。</p>
          </>
        )}
        <p>
          <a href={import.meta.env.BASE_URL + 'game-assets/attribution.txt'}>素材來源與署名</a>
        </p>
        {import.meta.env.DEV && mode !== 'multiplayer' && (
          <p>開發用傷害測試在 Forest Entrance 生效，並遵守受擊免疫與重生保護。倒地 3 秒後自動回 Village。</p>
        )}
        <form method="dialog">
          <button type="submit">關閉</button>
        </form>
      </dialog>
      <footer className="playground-footer">
        <ul aria-label="碰撞圖例">
          <li className="legend-solid">實體地形</li>
          <li className="legend-one-way">單向平台</li>
          <li className="legend-portal">傳送門</li>
          <li className="legend-boundary">世界邊界</li>
        </ul>
        <div
          className="playground-hud"
          aria-label="Beginner 狀態"
        >
          {presentation && (
            <>
              <span>
                {mode === 'scripted' ? '腳本播放' : '互動操作'} · {stateLabels[presentation.state]} · 朝
                {presentation.facing === 'left' ? '左' : '右'}
              </span>
              <span>
                HP {presentation.vitals.hp} / {presentation.vitals.maxHp}
              </span>
              <span>
                MP {presentation.vitals.mp} / {presentation.vitals.maxMp}
              </span>
              {presentation.atSafeHubSpawn && <span>安全區生成點</span>}
            </>
          )}
          {multiplayer && !failed && (
            <>
              <span>
                開發用多人測試 · {stateLabels[multiplayer.state]} · 朝{multiplayer.facing === 'left' ? '左' : '右'}
              </span>
              <span>
                HP {multiplayer.hp} / {multiplayer.maxHp}
              </span>
              <span aria-label="同房角色數">同房 {multiplayer.players} 人</span>
            </>
          )}
          {actions.length > 0 && <span>輸入 · {actions.map((action) => actionLabels[action]).join('／')}</span>}
        </div>
        {import.meta.env.DEV && interactive && presentation && (
          <div
            className="playground-toolbar"
            role="group"
            aria-label="開發用傷害測試"
          >
            <button
              type="button"
              disabled={presentation.state === 'death'}
              onClick={() => {
                pendingDebugDamage.current = 'damage'
              }}
            >
              測試受傷
            </button>
            <button
              type="button"
              disabled={presentation.state === 'death'}
              onClick={() => {
                pendingDebugDamage.current = 'lethal'
              }}
            >
              測試致死傷害
            </button>
          </div>
        )}
      </footer>
    </main>
  )
}
