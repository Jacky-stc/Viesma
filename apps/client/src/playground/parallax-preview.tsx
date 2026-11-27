import { initialPhysicsBalance, loadGrayboxGameData } from '@viesma/game-data'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { forestParallax } from '../rendering/forest-parallax'
import type { ForestRenderMode } from '../rendering/forest-terrain'
import type { ParallaxLayer } from '../rendering/parallax-layout'
import { createWorldRenderer } from '../rendering/world-renderer'
import './parallax-preview.css'

const body = { width: initialPhysicsBalance.bodyWidthWorldUnits, height: initialPhysicsBalance.bodyHeightWorldUnits }
const initialCamera = { x: 0, y: 304, zoom: 1, auto: false }
const modes = { graybox: '灰盒', rectangular: 'VF.2 矩形', organic: 'VF.2.1 自然地形' } as const
const numbers = [
  { key: 'factorX', title: 'X 因子', min: -4, max: 4 },
  { key: 'factorY', title: 'Y 因子', min: -4, max: 4 },
  { key: 'scale', title: '縮放', min: 0.1, max: 4 },
  { key: 'offsetX', title: 'X 位移', min: -8192, max: 8192 },
  { key: 'offsetY', title: 'Y 位移', min: -8192, max: 8192 },
  { key: 'opacity', title: '不透明度', min: 0, max: 1 },
] as const

function NumericField({
  label,
  value,
  min,
  max,
  onValue,
}: {
  label: string
  value: number
  min: number
  max: number
  onValue(value: number): void
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        step="any"
        min={min}
        max={max}
        defaultValue={value}
        onChange={({ currentTarget }) => {
          const next = currentTarget.valueAsNumber
          if (next >= min && next <= max) onValue(next)
        }}
        onBlur={({ currentTarget }) => {
          currentTarget.value = String(value)
        }}
      />
    </label>
  )
}

function ParallaxPreview() {
  const [map] = useState(() => loadGrayboxGameData().tiledMaps.find(({ id }) => id === 'm1'))
  const spawn = map?.spawns.find(({ id }) => id === 'spawn_from_village')
  const [camera, setCamera] = useState(initialCamera)
  const [layers, setLayers] = useState(forestParallax)
  const [mode, setMode] = useState<ForestRenderMode>('organic')
  const activeLayers = useMemo(
    () => (mode === 'graybox' ? [] : mode === 'rectangular' ? layers : layers.filter(({ plane }) => plane === 'background')),
    [layers, mode]
  )
  const [showCollision, setShowCollision] = useState(false)
  const [preset, setPreset] = useState<'desktop' | 'mobile'>('desktop')
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const [renderError, setRenderError] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const stats = useRef<HTMLOutputElement>(null)
  const current = useRef({ camera, activeLayers, mode, showCollision })

  useEffect(() => {
    current.current = { camera, activeLayers, mode, showCollision }
  }, [camera, activeLayers, mode, showCollision])

  useEffect(() => {
    const surface = host.current
    if (!surface || !map || !spawn) return
    const controller = new AbortController()
    let frameId = 0
    let autoDistance = 0
    let lastFrame = 0
    let sampleStart = 0
    let frames = 0
    void createWorldRenderer(surface, body, controller.signal, { previewParallax: true })
      .then((renderer) => {
        if (!renderer || controller.signal.aborted) return
        const draw = (now: number) => {
          const { camera, activeLayers, mode, showCollision } = current.current
          const elapsed = lastFrame ? Math.min(now - lastFrame, 100) : 0
          lastFrame = now
          const travel = map.bounds.width - 1280
          autoDistance = camera.auto ? (autoDistance + elapsed * 0.18) % (2 * travel) : 0
          const x = camera.x + Math.min(autoDistance, 2 * travel - autoDistance)
          renderer.render(
            { map, position: spawn.position, facing: spawn.facing, state: 'idle', visualTick: (now / 1000) * 30 },
            { origin: { x, y: camera.y }, zoom: camera.zoom, layers: activeLayers, mode, showCollision }
          )
          if (sampleStart === 0) sampleStart = now
          else frames++
          if (now - sampleStart >= 500 && stats.current) {
            const fps = (1000 * frames) / (now - sampleStart)
            const sample = renderer.parallaxStats()
            const memory = (sample?.decodedBytes ?? 0) / 2 ** 20
            const terrain = renderer.terrainStats()
            const terrainMemory = ((terrain?.decodedBytes ?? 0) / 2 ** 20).toFixed(2)
            stats.current.value = `${fps.toFixed(1)} FPS · ${memory.toFixed(2)} MiB RGBA8 · ${sample?.loaded ?? 0}/${activeLayers.length} 張紋理 · X ${x.toFixed(0)} · L4 ${terrainMemory} MiB / ${terrain?.cells ?? 0} 段`
            sampleStart = now
            frames = 0
          }
          frameId = requestAnimationFrame(draw)
        }
        frameId = requestAnimationFrame(draw)
      })
      .catch(() => {
        if (!controller.signal.aborted) setRenderError('無法啟動 WebGL 預覽。')
      })
    return () => {
      cancelAnimationFrame(frameId)
      controller.abort()
    }
  }, [map, spawn])

  function updateLayer(assetId: string, changes: Partial<ParallaxLayer>) {
    setLayers((previous) => previous.map((layer) => (layer.assetId === assetId ? { ...layer, ...changes } : layer)))
  }

  function configJson() {
    return JSON.stringify({ mapId: map?.id, mode, layers: activeLayers }, null, 2) + '\n'
  }

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(configJson())
      setNotice('已複製設定。')
    } catch {
      setNotice('剪貼簿無法使用，可下載 JSON。')
    }
  }

  function downloadConfig() {
    const url = URL.createObjectURL(new Blob([configJson()], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'forest-parallax.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function reset() {
    setCamera(initialCamera)
    setLayers(forestParallax)
    setMode('organic')
    setShowCollision(false)
    setPreset('desktop')
    setNotice('已重設。')
    setRevision((previous) => previous + 1)
  }

  return (
    <main>
      <header className="preview-content">
        <h1>
          Forest Entrance <span>視差預覽</span>
        </h1>
        <div
          className="preview-actions"
          role="group"
          aria-label="視窗預設"
        >
          <button
            type="button"
            aria-pressed={preset === 'desktop'}
            onClick={() => setPreset('desktop')}
          >
            桌面
          </button>
          <button
            type="button"
            aria-pressed={preset === 'mobile'}
            onClick={() => setPreset('mobile')}
          >
            手機橫向
          </button>
        </div>
        <div
          className="preview-actions"
          role="group"
          aria-label="渲染模式"
        >
          {(Object.keys(modes) as ForestRenderMode[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => setMode(option)}
            >
              {modes[option]}
            </button>
          ))}
        </div>
      </header>
      <figure
        className="preview-frame"
        data-preset={preset}
      >
        <div
          className="preview-canvas"
          ref={host}
        />
        <figcaption>
          Beginner {body.width} × {body.height} world units · 入口地面 Y = {(spawn?.position.y ?? 0) + body.height}
        </figcaption>
      </figure>
      <div
        className="preview-content preview-controls"
        key={revision}
      >
        {renderError && <p role="alert">{renderError}</p>}
        <div className="preview-actions">
          <NumericField
            label="相機 X"
            value={camera.x}
            min={-8192}
            max={8192}
            onValue={(x) => setCamera((prev) => ({ ...prev, x }))}
          />
          <NumericField
            label="相機 Y"
            value={camera.y}
            min={-4096}
            max={4096}
            onValue={(y) => setCamera((prev) => ({ ...prev, y }))}
          />
          <NumericField
            label="相機縮放"
            value={camera.zoom}
            min={0.25}
            max={4}
            onValue={(zoom) => setCamera((prev) => ({ ...prev, zoom }))}
          />
          <label className="preview-check">
            <input
              type="checkbox"
              checked={camera.auto}
              onChange={({ currentTarget }) => {
                const auto = currentTarget.checked
                setCamera((prev) => ({ ...prev, auto }))
              }}
            />
            水平自動移動
          </label>
          <label className="preview-check">
            <input
              type="checkbox"
              checked={showCollision}
              onChange={({ currentTarget }) => setShowCollision(currentTarget.checked)}
            />
            碰撞邊界
          </label>
          <output
            aria-label="效能"
            aria-live="off"
            ref={stats}
          >
            等待渲染
          </output>
        </div>
        <div className="preview-layers">
          {activeLayers.map((layer) => (
            <fieldset key={layer.assetId}>
              <legend>{layer.assetId}</legend>
              <div className="preview-layer-fields">
                <label className="preview-check">
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    onChange={({ currentTarget }) => updateLayer(layer.assetId, { visible: currentTarget.checked })}
                  />
                  顯示
                </label>
                <label className="preview-check">
                  <input
                    type="checkbox"
                    checked={layer.repeatX}
                    onChange={({ currentTarget }) => updateLayer(layer.assetId, { repeatX: currentTarget.checked })}
                  />
                  水平重複
                </label>
                {numbers.map(({ key, title, min, max }) => (
                  <NumericField
                    key={key}
                    label={title}
                    value={layer[key]}
                    min={min}
                    max={max}
                    onValue={(value) => updateLayer(layer.assetId, { [key]: value })}
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="preview-actions">
          <button
            type="button"
            onClick={() => void copyConfig()}
          >
            複製 JSON
          </button>
          <button
            type="button"
            onClick={downloadConfig}
          >
            下載 JSON
          </button>
          <button
            type="button"
            onClick={reset}
          >
            重設
          </button>
          <span role="status">{notice}</span>
        </div>
      </div>
    </main>
  )
}

const root = document.getElementById('root')
if (import.meta.env.DEV && root) createRoot(root).render(<ParallaxPreview />)
