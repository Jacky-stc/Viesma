# ADR-006 — 使用 PostgreSQL 與 Drizzle 保存角色 economy

- 狀態：Accepted，Task 0 架構基線。
- 日期：2026-11-23。
- 適用範圍：accounts、characters、progression、currency、inventory、equipment、ground grants 與 idempotency receipts。

## 背景

Reward／pickup／equip 可能因 concurrent commands、斷線重送、DB timeout 或 process crash 執行多次。單純在 memory 設一個 processed flag 無法跨重啟保護；把 character JSON 整份定期覆寫也可能蓋掉新 inventory 或已提交 AP。

## 決策

使用 PostgreSQL 作 durable source of truth，Drizzle 作 typed schema／queries／migrations；保留 explicit transaction 與 SQL row-lock 能力。Normalized inventory item 只有一個 location，slot／quantity／ownership 有 FK／CHECK／unique constraints。Derived stats 重算，不作可由 client 覆寫的真值。

每個 mutation 經 CharacterCoordinator 排序；多角色按 characterId 取得 locks，DB 同順序鎖 rows。初始 READ COMMITTED＋明確 row locks、unique keys 與 runtime validation；不能只靠 application mutex 或 isolation label。

一次 monster death 的 recipients EXP／level／AP、rolled ground grants、death／grant receipts 在同一 transaction；pickup 的 inventory／currency 及 ground state 同一 transaction；equip／AP／consume 有各自 receipt。Unique deathId、(deathId,characterId)、lootId、(characterId,sessionEpoch,requestId) 防止重複 mutation。

Commit 才回成功；ambiguous COMMIT 重新讀 receipt。Retry 重用凍結結果，不能重新 roll loot。未過期 ground grants 可在原 room 消失後重新綁定 owner 當前同 map instance，expiry 不延長。已確認 inventory 與進度可在 app crash 後恢復。

## 考慮過的方案

- **僅 memory／localStorage**：適用 MVP-A，不能達成多人 economy 與 crash recovery。
- **JSON file／整份 character blob**：部署簡單，但 concurrent mutation／constraint／query／migration 成本較高。
- **其他 SQL 或 document DB**：可實作相同需求，沒有足以偏離指定 PostgreSQL stack 的相容性問題。
- **全面 event sourcing**：audit 與 replay 有價值，但 MVP 使用必要 death／command receipts 即可，無需完整 event-store framework。

## 影響

需要 schema／migration、真 PG integration tests、backup／restore 與 outage policy。Room tick 不 await DB，以 RewardPending＋worker 結算。HP／MP／movement、party、monsters 不持久化；新 play session 在 Village 重建。未 commit 的 combat death 不承諾跨 crash 保留，已確認 economy 不可回退。

## 驗證與重評

M7.1 做 schema／constraints，M7.4 驗證 row lock／rollback／duplicate／full bag／ambiguous commit，M7.5 驗證 kill-after-commit 與 loot rebind，M8.4 做 backup restore。使用真 PG，mock transaction 不算驗證 race condition。

相關文件：[ARCHITECTURE §7–§9](../ARCHITECTURE.md)。官方參考：[Drizzle Transactions](https://orm.drizzle.team/docs/transactions)、[PostgreSQL Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)。
