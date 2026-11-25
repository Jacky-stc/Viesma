import type { LootResultCode } from '@viesma/protocol'
import type { GuideInteraction } from '@viesma/simulation'
import { useEffect, useRef, useState } from 'react'
import { touchControls } from '../input/browser-input'
import type { AuxiliaryAction } from '../input/input-state'
import type { MultiplayerPresentation } from '../multiplayer/run-multiplayer'
import { ApPanel } from './ap-panel'
import { InventoryPanel } from './inventory-panel'
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

function lootFeedback(kind: 'pickup' | 'consume', code: LootResultCode): string {
  if (code === 'PENDING') return kind === 'pickup' ? '正在拾取…' : '正在使用藥水…'
  if (code === 'CONFIRMED') return kind === 'pickup' ? '拾取成功' : '已使用藥水'
  const messages = {
    CONSUMED_NO_EFFECT: '藥水已消耗，未恢復數值',
    CONSUMED_DEAD: '使用完成，角色已死亡',
    INVALID_ITEM: '物品資料無效',
    BAG_FULL: '背包空間不足',
    SOURCE_CHANGED: '背包沒有對應的藥水，或來源已變更',
    CURRENCY_LIMIT: '已達金幣上限',
    STALE_BINDING: '連線已更新，請重新操作',
    STALE_VERSION: '角色資料已更新，請重新操作',
    UNAVAILABLE: '目前無法操作',
    STALE_REQUEST: '請求已失效，請重新操作',
    REQUEST_CONFLICT: '請求內容衝突',
    BUSY: '伺服器忙碌，請重新操作',
    LOOT_UNAVAILABLE: '附近沒有可拾取的掉落物',
    LOOT_EXPIRED: '掉落物已過期',
    TOO_FAR: '離掉落物太遠',
    RESOURCE_FULL: '數值已滿',
    COOLDOWN: '藥水冷卻中',
  }
  return messages[code]
}

export function Playground() {
  const hostRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLElement>(null)
  const helpRef = useRef<HTMLDialogElement>(null)
  const apRef = useRef<HTMLDialogElement>(null)
  const inventoryRef = useRef<HTMLDialogElement>(null)
  const inventoryCloseRef = useRef<HTMLButtonElement>(null)
  const startup = useRef(Promise.resolve())
  const pendingDebugDamage = useRef<DebugDamage>(undefined)
  const pendingGuideClose = useRef<GuideInteraction>(undefined)
  const [active, setActive] = useState(true)
  const [mode, setMode] = useState<Mode>('interactive')
  const [presentation, setPresentation] = useState<PlaygroundPresentation>()
  const [multiplayer, setMultiplayer] = useState<MultiplayerPresentation>()
  const [multiplayerStatus, setMultiplayerStatus] = useState('')
  const [actions, setActions] = useState<readonly AuxiliaryAction[]>([])
  const [failed, setFailed] = useState(false)
  const interactive = active && mode === 'interactive'
  const online = active && mode === 'multiplayer'
  const controlsReady = (interactive && presentation) || (online && multiplayer && !failed)
  const progression = online && !failed ? multiplayer?.progression : undefined
  const inventory = online && !failed ? multiplayer?.inventory : undefined
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
          return runMultiplayer(
            host,
            surface,
            setMultiplayer,
            setMultiplayerStatus,
            failedStartup,
            toggleApPanel,
            toggleInventory,
            controller.signal
          )
        }
        return runPlayground(host, surface, mode, setPresentation, setActions, controller.signal, takeGuideClose, takeDebugDamage)
      })
      .catch(failedStartup)
    return () => controller.abort()
  }, [active, mode])

  useEffect(() => {
    const panel = inventoryRef.current
    if (panel?.open && !panel.contains(document.activeElement)) {
      inventoryCloseRef.current?.focus({ preventScroll: true })
    }
  }, [inventory, multiplayer?.equipmentStatus])

  useEffect(() => {
    if (!online) return
    function closeInventoryOnKey(event: KeyboardEvent) {
      const panel = inventoryRef.current
      if (!panel?.open || event.code !== 'KeyI' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) panel.close()
    }
    document.addEventListener('keydown', closeInventoryOnKey, true)
    return () => document.removeEventListener('keydown', closeInventoryOnKey, true)
  }, [online])

  function resetStatus() {
    pendingDebugDamage.current = undefined
    pendingGuideClose.current = undefined
    setPresentation(undefined)
    setMultiplayer(undefined)
    setMultiplayerStatus('')
    setActions([])
    setFailed(false)
  }

  function toggleScene() {
    resetStatus()
    setActive(!active)
  }

  function toggleApPanel() {
    const panel = apRef.current
    if (panel?.open) panel.close()
    else panel?.showModal()
  }

  function toggleInventory() {
    const panel = inventoryRef.current
    if (panel?.open) panel.close()
    else panel?.showModal()
  }

  return (
    <main className="playground">
      <header className="playground-header">
        <div>
          <h1>Viesma</h1>
          <p aria-label="目前地圖">{(online ? multiplayer?.mapName : presentation?.mapName) ?? 'Beginner 平台測試場'}</p>
          {online && <p>開發用匿名身分 · 進度僅暫存於伺服器記憶體</p>}
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
                {touchControls.slice(0, 3).map(({ control, label, text }) => (
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
                {touchControls
                  .slice(3)
                  .filter(({ control }) => !online || control !== 'interact')
                  .map(({ control, label, text }) => (
                    <button
                      key={control}
                      type="button"
                      data-input-control={control}
                      aria-label={label}
                    >
                      {text}
                    </button>
                  ))}
                {progression && (
                  <button
                    type="button"
                    onClick={toggleApPanel}
                  >
                    能力點數
                  </button>
                )}
                {inventory && (
                  <button
                    type="button"
                    onClick={toggleInventory}
                  >
                    物品欄
                  </button>
                )}
              </div>
            </div>
            {controlsReady && <p className="playground-rotate">請將裝置轉為橫向以操作。</p>}
          </>
        )}
        {(!active || failed || !(online ? multiplayer : presentation) || (online && multiplayerStatus)) && (
          <p
            className="playground-status"
            role={failed ? 'alert' : 'status'}
          >
            {failed
              ? online
                ? '多人場景已中斷或無法啟動，請確認本機伺服器與 WebGL 後重新載入。'
                : '無法啟動場景，請確認瀏覽器支援 WebGL。'
              : online
                ? multiplayerStatus || '連線至 M1…'
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
          <p>
            可使用 ←／A、→／D 與 Space 移動及跳躍。站在 Village 或 M1 的傳送門內，按 ↑／W 或觸控 ↑ 往返。按 K
            或點觸控「能力點數」查看成長與配置 AP。按 F 或「拾取」撿起附近的個人掉落物，按 1／2 或「HP 藥水」／「MP 藥水」使用藥水。
          </p>
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
      {online && (
        <dialog
          className="playground-help ap-panel"
          aria-labelledby="ap-panel-title"
          ref={apRef}
          onClose={() => surfaceRef.current?.focus({ preventScroll: true })}
          onKeyDown={(event) => {
            if (event.code === 'KeyK' && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault()
              toggleApPanel()
            }
          }}
        >
          <header>
            <h2 id="ap-panel-title">能力點數</h2>
            <button
              type="button"
              onClick={toggleApPanel}
            >
              關閉
            </button>
          </header>
          {progression && multiplayer ? (
            <ApPanel
              key={progression.connectionEpoch}
              snapshot={progression}
              status={multiplayer.apStatus}
              unavailable={Boolean(multiplayerStatus) || multiplayer.state === 'death'}
              allocate={multiplayer.allocateAp}
            />
          ) : (
            <p>等待角色進度…</p>
          )}
        </dialog>
      )}
      {online && (
        <dialog
          className="playground-help ap-panel inventory-panel"
          aria-labelledby="inventory-title"
          ref={inventoryRef}
          onClose={() => surfaceRef.current?.focus({ preventScroll: true })}
        >
          <header>
            <h2 id="inventory-title">物品欄</h2>
            {inventory && <span>金幣 {inventory.currency}</span>}
            <button
              type="button"
              onClick={toggleInventory}
              ref={inventoryCloseRef}
            >
              關閉
            </button>
          </header>
          {inventory && multiplayer ? (
            <InventoryPanel
              key={inventory.connectionEpoch}
              snapshot={inventory}
              items={multiplayer.items}
              status={multiplayer.equipmentStatus}
              unavailable={Boolean(multiplayerStatus) || multiplayer.state === 'death'}
              changeEquipment={multiplayer.changeEquipment}
            />
          ) : (
            <p>等待背包資料…</p>
          )}
        </dialog>
      )}
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
                {stateLabels[multiplayer.state]} · 朝{multiplayer.facing === 'left' ? '左' : '右'}
              </span>
              <span>
                HP {multiplayer.hp} / {multiplayer.maxHp}
              </span>
              <span aria-label="同房角色數">同房 {multiplayer.players} 人</span>
              {progression && (
                <>
                  <span>Lv. {progression.level}</span>
                  <span>
                    {progression.nextLevelExp === null
                      ? `EXP ${progression.expWithinLevel} · 已達上限`
                      : `EXP ${progression.expWithinLevel} / ${progression.nextLevelExp}`}
                  </span>
                  <span>可用 AP {progression.unspentAp}</span>
                  <button
                    className="ap-hud-button"
                    type="button"
                    onClick={toggleApPanel}
                  >
                    能力點數（K）
                  </button>
                </>
              )}
              {inventory && (
                <>
                  <span>金幣 {inventory.currency}</span>
                  <button
                    className="ap-hud-button"
                    type="button"
                    onClick={toggleInventory}
                  >
                    物品欄（I）
                  </button>
                </>
              )}
              <span
                role="status"
                aria-label="戰鬥獎勵"
              >
                {multiplayer.reward &&
                  [
                    multiplayer.reward.experience > 0 && `EXP +${multiplayer.reward.experience}`,
                    multiplayer.reward.levelsGained > 0 && `升級 +${multiplayer.reward.levelsGained}`,
                    multiplayer.reward.lootCount > 0 && `個人掉落 ${multiplayer.reward.lootCount} 筆`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
              </span>
              <span
                role="status"
                aria-label="拾取結果"
              >
                {multiplayer.pickupStatus && lootFeedback('pickup', multiplayer.pickupStatus)}
              </span>
              <span
                role="status"
                aria-label="藥水使用結果"
              >
                {multiplayer.consumeStatus && lootFeedback('consume', multiplayer.consumeStatus)}
              </span>
              {multiplayer.state === 'death' && <span role="status">已倒下，等待返回 Village</span>}
              {multiplayer.spawnProtected && <span role="status">重生保護</span>}
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
