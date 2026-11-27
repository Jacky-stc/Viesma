import { useState } from 'react'
import catalog from 'virtual:viesma-assets'
import { face01SpriteId, indexSprites, type FaceCalibration } from '../rendering/assets/catalog'
import {
  characterPreviewHeights,
  characterPreviewModes,
  defaultCharacterPreview,
  idlePreviewFrames,
  idlePreviewSpeeds,
  initialFaceCalibration,
  type CharacterPreviewMode,
  type CharacterPreviewOptions,
} from '../rendering/character-preview'

const defaultFaceCalibration =
  (import.meta.env.DEV ? indexSprites(catalog).get(face01SpriteId)?.sprite.attachedFace?.defaultCalibration : undefined) ??
  initialFaceCalibration

const modes: readonly { readonly value: CharacterPreviewMode; readonly label: string }[] = [
  { value: 'base-body', label: 'Static Base Body' },
  { value: 'animated-base-body', label: 'Animated Base Body' },
  { value: 'paper-doll', label: 'Paper Doll' },
  { value: 'character-master', label: 'Character Master' },
  { value: 'legacy', label: 'Legacy' },
]

const calibrationFields = [
  { key: 'xPx', label: '水平偏移 X', min: -32, max: 32, step: 0.5, unit: ' px' },
  { key: 'yPx', label: '垂直偏移 Y', min: -32, max: 32, step: 0.5, unit: ' px' },
  { key: 'scale', label: '等比縮放', min: 0.5, max: 1.5, step: 0.01, unit: 'x' },
] as const

function FaceCalibrationControls({
  disabled,
  calibration,
  onChange,
}: {
  readonly disabled: boolean
  readonly calibration: FaceCalibration
  readonly onChange: (value: FaceCalibration) => void
}) {
  const [copyStatus, setCopyStatus] = useState('')
  function change(value: FaceCalibration) {
    setCopyStatus('')
    onChange(value)
  }
  async function copy() {
    try {
      await globalThis.navigator.clipboard.writeText(JSON.stringify(calibration))
      setCopyStatus('已複製')
    } catch {
      setCopyStatus(JSON.stringify(calibration))
    }
  }
  return (
    <details className="face-calibration">
      <summary>Face 01 校正</summary>
      <fieldset disabled={disabled}>
        {calibrationFields.map(({ key, label, min, max, step, unit }) => (
          <label key={key}>
            {label}
            <input
              aria-label={label}
              type="range"
              min={min}
              max={max}
              step={step}
              value={calibration[key]}
              onChange={(event) => change({ ...calibration, [key]: event.target.valueAsNumber })}
            />
            <output>
              {calibration[key]}
              {unit}
            </output>
          </label>
        ))}
        <div className="face-calibration-actions">
          <button
            type="button"
            onClick={() => change(defaultFaceCalibration)}
          >
            重置校正
          </button>
          <button
            type="button"
            onClick={() => void copy()}
          >
            複製校正 JSON
          </button>
        </div>
        <output aria-live="polite">{copyStatus}</output>
      </fieldset>
    </details>
  )
}

export function CharacterPreviewControls({ onChange }: { readonly onChange: (options: CharacterPreviewOptions) => void }) {
  const [options, setOptions] = useState(() => ({ ...defaultCharacterPreview, faceCalibration: defaultFaceCalibration }))
  function update(patch: Partial<CharacterPreviewOptions>) {
    const next = { ...options, ...patch }
    setOptions(next)
    onChange(next)
  }
  function updateIdle(patch: Partial<CharacterPreviewOptions['idle']>) {
    update({ idle: { ...options.idle, ...patch } })
  }

  return (
    <details className="character-preview">
      <summary>角色預覽</summary>
      <div className="character-preview-options">
        <label>
          角色素材
          <select
            value={options.mode}
            onChange={(event) => {
              const mode = modes.find(({ value }) => value === event.target.value)?.value
              if (mode !== undefined) update({ mode, height: characterPreviewModes[mode].defaultHeight })
            }}
          >
            {modes.map(({ value, label }) => (
              <option
                key={value}
                value={value}
              >
                {label}
              </option>
            ))}
          </select>
        </label>
        {(options.mode === 'animated-base-body' || options.mode === 'paper-doll') && (
          <>
            <button
              type="button"
              onClick={() => updateIdle({ playing: !options.idle.playing, frame: null })}
            >
              {options.idle.playing ? 'Pause' : 'Play'}
            </button>
            <label>
              動畫幀
              <select
                value={options.idle.frame ?? ''}
                onChange={(event) => {
                  const frame = idlePreviewFrames.find((value) => String(value) === event.target.value)
                  updateIdle({ frame: frame ?? null, playing: frame === undefined })
                }}
              >
                <option value="">自動</option>
                {idlePreviewFrames.map((frame) => (
                  <option
                    key={frame}
                    value={frame}
                  >
                    Frame {frame}
                  </option>
                ))}
              </select>
            </label>
            <label>
              播放速度
              <select
                value={options.idle.speed}
                onChange={(event) => {
                  const speed = idlePreviewSpeeds.find((value) => String(value) === event.target.value)
                  if (speed !== undefined) updateIdle({ speed })
                }}
              >
                {idlePreviewSpeeds.map((speed) => (
                  <option
                    key={speed}
                    value={speed}
                  >
                    {speed}x
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={options.idle.showAttachments}
                onChange={(event) => updateIdle({ showAttachments: event.target.checked })}
              />
              掛載點
            </label>
          </>
        )}
        {options.mode === 'paper-doll' && (
          <>
            <label>
              <input
                type="checkbox"
                checked={options.showFace}
                disabled={options.showDiagnosticLayers}
                onChange={(event) => update({ showFace: event.target.checked })}
              />
              Face 01 圖層
            </label>
            <FaceCalibrationControls
              disabled={options.showDiagnosticLayers}
              calibration={options.faceCalibration}
              onChange={(faceCalibration) => update({ faceCalibration })}
            />
            <label>
              <input
                type="checkbox"
                checked={options.showDiagnosticLayers}
                onChange={(event) => update({ showDiagnosticLayers: event.target.checked })}
              />
              測試外觀圖層
            </label>
            <label>
              <input
                type="checkbox"
                checked={options.showLayerOrder}
                onChange={(event) => update({ showLayerOrder: event.target.checked })}
              />
              圖層順序
            </label>
          </>
        )}
        <label>
          角色高度
          <select
            value={options.mode === 'legacy' ? '' : options.height}
            disabled={options.mode === 'legacy'}
            onChange={(event) => {
              const height = characterPreviewHeights.find((value) => String(value) === event.target.value)
              if (height !== undefined) update({ height })
            }}
          >
            {options.mode === 'legacy' && <option value="">原始尺寸</option>}
            {characterPreviewHeights.map((height) => (
              <option
                key={height}
                value={height}
              >
                {height}
              </option>
            ))}
          </select>
        </label>
        <label>
          本機角色朝向
          <select
            value={options.facing}
            onChange={(event) => {
              const value = event.target.value
              update({ facing: value === 'left' || value === 'right' ? value : 'gameplay' })
            }}
          >
            <option value="gameplay">跟隨操作</option>
            <option value="left">向左</option>
            <option value="right">向右</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.showCollision}
            onChange={(event) => update({ showCollision: event.target.checked })}
          />
          角色碰撞框
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.showFootAnchor}
            onChange={(event) => update({ showFootAnchor: event.target.checked })}
          />
          腳底錨點
        </label>
      </div>
    </details>
  )
}
