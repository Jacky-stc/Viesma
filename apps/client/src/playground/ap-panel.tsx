import { attributeNames, type Attributes } from '@viesma/domain'
import type { ApResultCode, OwnerProgression } from '@viesma/protocol'
import { useState } from 'react'

const emptyDeltas: Attributes = { str: 0, dex: 0, int: 0, luk: 0 }

const apStatusLabels = {
  PENDING: '等待伺服器確認…',
  CONFIRMED: '能力點數已配置',
  INVALID_ALLOCATION: '配置值必須為非負整數',
  INSUFFICIENT_AP: '可用 AP 不足',
  STALE_BINDING: '連線已變更，請重新配置',
  STALE_VERSION: '角色進度已更新，請重新配置',
  UNAVAILABLE: '倒地或換圖期間無法配置 AP',
  STALE_REQUEST: '請求已過期，請重新配置',
  REQUEST_CONFLICT: '請求內容衝突，請重新配置',
  BUSY: '上一筆配置仍在處理',
} satisfies Record<'PENDING' | ApResultCode, string>

interface ApPanelProps {
  readonly snapshot: OwnerProgression
  readonly status: keyof typeof apStatusLabels | undefined
  readonly unavailable: boolean
  readonly allocate: (deltas: Attributes, snapshot: OwnerProgression) => boolean
}

export function ApPanel({ snapshot, status, unavailable, allocate }: ApPanelProps) {
  const [deltas, setDeltas] = useState(emptyDeltas)
  const { baseAttributes, stats, unspentAp } = snapshot
  const pending = status === 'PENDING'
  const canSubmit = !unavailable && !pending && attributeNames.some((name) => deltas[name] > 0)
  return (
    <>
      <p>可用 AP {unspentAp}</p>
      <dl
        className="ap-stats"
        aria-label="衍生戰鬥屬性"
      >
        <div>
          <dt>最大 HP</dt>
          <dd>{stats.maxHp}</dd>
        </div>
        <div>
          <dt>最大 MP</dt>
          <dd>{stats.maxMp}</dd>
        </div>
        <div>
          <dt>攻擊力</dt>
          <dd>{stats.attackPower}</dd>
        </div>
        <div>
          <dt>物理防禦</dt>
          <dd>{stats.physicalDefense}</dd>
        </div>
        <div>
          <dt>魔法防禦</dt>
          <dd>{stats.magicDefense}</dd>
        </div>
        <div>
          <dt>暴擊機率</dt>
          <dd>{stats.criticalChanceBps / 100}%</dd>
        </div>
        <div>
          <dt>暴擊倍率</dt>
          <dd>{stats.criticalMultiplierPercent}%</dd>
        </div>
      </dl>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit && allocate(deltas, snapshot)) setDeltas(emptyDeltas)
        }}
      >
        <fieldset
          className="ap-attributes"
          disabled={unavailable || pending}
        >
          <legend>基礎屬性與配置</legend>
          {attributeNames.map((name) => (
            <label key={name}>
              <span>
                {name.toUpperCase()} <strong>{baseAttributes[name]}</strong>
              </span>
              <input
                aria-label={`${name.toUpperCase()} 配置`}
                type="number"
                inputMode="numeric"
                min={0}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                required
                value={Number.isNaN(deltas[name]) ? '' : deltas[name]}
                onChange={(event) => setDeltas({ ...deltas, [name]: event.target.valueAsNumber })}
              />
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          aria-disabled={!canSubmit}
        >
          配置 AP
        </button>
      </form>
      {status && <p role="status">{apStatusLabels[status]}</p>}
    </>
  )
}
