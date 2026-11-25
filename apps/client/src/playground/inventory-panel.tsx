import { equipmentSlots, type EquipmentOperation, type EquipmentSlot } from '@viesma/domain'
import type { EquipmentModifiers, ItemDefinition } from '@viesma/game-data'
import type { EquipmentResultCode, OwnerInventory } from '@viesma/protocol'
import { useState } from 'react'

const slotNames = { weapon: '武器', armor: '防具', accessory: '飾品' } satisfies Record<EquipmentSlot, string>
const modifierNames = {
  str: 'STR',
  dex: 'DEX',
  int: 'INT',
  luk: 'LUK',
  maxHp: '最大 HP',
  maxMp: '最大 MP',
  attackPower: '攻擊力',
  physicalDefense: '物理防禦',
  magicDefense: '魔法防禦',
  criticalChanceBps: '暴擊率',
} satisfies Record<keyof EquipmentModifiers, string>

const statusText = {
  PENDING: '等待伺服器確認…',
  CONFIRMED: '裝備已更新',
  INVALID_ITEM: '物品資料無效',
  BAG_FULL: '背包已滿',
  SOURCE_CHANGED: '所選物品已變更',
  WRONG_SLOT: '裝備槽不相容',
  LEVEL_REQUIRED: '角色等級不足',
  STALE_BINDING: '連線已更新，請重新操作',
  STALE_VERSION: '角色資料已更新，請重新操作',
  UNAVAILABLE: '目前無法變更裝備',
  STALE_REQUEST: '請求已過期，請重新操作',
  REQUEST_CONFLICT: '請求內容衝突',
  BUSY: '伺服器忙碌，請重新操作',
} satisfies Record<'PENDING' | EquipmentResultCode, string>

interface InventoryPanelProps {
  readonly snapshot: OwnerInventory
  readonly items: readonly ItemDefinition[]
  readonly status: 'PENDING' | EquipmentResultCode | undefined
  readonly unavailable: boolean
  readonly changeEquipment: (operation: EquipmentOperation, snapshot: OwnerInventory) => boolean
}

export function InventoryPanel({ snapshot, items, status, unavailable, changeEquipment }: InventoryPanelProps) {
  const [selection, setSelection] = useState<number | EquipmentSlot>()
  const selected = typeof selection === 'number' ? snapshot.bag[selection] : selection ? snapshot.equipment[selection] : undefined
  const definition = items.find(({ id }) => id === selected?.itemDefinitionId)
  const displayName = (id: string) => items.find((item) => item.id === id)?.name ?? id

  function submit() {
    if (selection === undefined || !selected?.itemInstanceId || definition?.kind !== 'equipment') return
    const itemInstanceId = selected.itemInstanceId
    changeEquipment(
      typeof selection === 'number'
        ? { kind: 'equip', bagSlot: selection, slot: definition.slot, itemInstanceId }
        : { kind: 'unequip', slot: selection, itemInstanceId },
      snapshot
    )
  }

  return (
    <div className="inventory-layout">
      <section aria-labelledby="inventory-bag-title">
        <h3 id="inventory-bag-title">背包</h3>
        <ul className="inventory-bag">
          {snapshot.bag.map((item, slot) => (
            <li key={slot}>
              <button
                type="button"
                aria-label={`背包槽 ${slot + 1} · ${item ? `${displayName(item.itemDefinitionId)} ×${item.quantity}` : '空'}`}
                aria-pressed={selection === slot}
                disabled={!item}
                onClick={() => setSelection(slot)}
              >
                {item && (
                  <>
                    <span>{displayName(item.itemDefinitionId)}</span>
                    <small>×{item.quantity}</small>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <div>
        <section aria-labelledby="inventory-equipped-title">
          <h3 id="inventory-equipped-title">裝備</h3>
          <ul className="inventory-equipped">
            {equipmentSlots.map((slot) => {
              const item = snapshot.equipment[slot]
              return (
                <li key={slot}>
                  <button
                    type="button"
                    aria-pressed={selection === slot}
                    disabled={!item}
                    onClick={() => setSelection(slot)}
                  >
                    {slotNames[slot]} · {item ? displayName(item.itemDefinitionId) : '空'}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
        {definition && selected && (
          <section
            className="inventory-details"
            aria-label="物品詳情"
          >
            <h3>{definition.name}</h3>
            {definition.kind === 'equipment' ? (
              <>
                <p>
                  {slotNames[definition.slot]} · 需求等級 {definition.requiredLevel}
                </p>
                <p>
                  {(Object.entries(definition.modifiers) as [keyof EquipmentModifiers, number][])
                    .map(([key, value]) => `${modifierNames[key]} +${key === 'criticalChanceBps' ? `${value / 100}%` : value}`)
                    .join(' · ')}
                </p>
                <button
                  type="button"
                  disabled={unavailable || status === 'PENDING'}
                  onClick={submit}
                >
                  {typeof selection === 'number' ? '裝備物品' : '卸下裝備'}
                </button>
              </>
            ) : (
              <p>
                {definition.kind === 'consumable'
                  ? `消耗品 · 恢復 ${definition.restoreAmount} ${definition.resource.toUpperCase()}`
                  : '素材'}{' '}
                · 數量 {selected.quantity}
              </p>
            )}
          </section>
        )}
        <p role="status">{status && statusText[status]}</p>
      </div>
    </div>
  )
}
