# ADR-003 — 採用 shared monsters，而非 private PvE

- 狀態：Accepted，Task 0 架構基線。
- 日期：2026-11-23。
- 適用範圍：map instances、monster lifecycle、damage attribution 與 late join。

## 背景

核心體驗要求多名玩家同圖探索、協力攻擊同一隻 monster、看見同一 HP 與死亡。每個 client 私有 spawn／HP 只能提供外觀上的多人，無法支持真正的 party combat 或 competing groups。

## 決策

每個 MapRoom／MapSimulation 擁有一份共享 monster collection，一個 map instance 最多20名角色。Monster AI、HP、aggro、attack、death claim、respawn generation 只有 server writer。Late join 接收當前權威狀態，不在 client 重建一套初始 monsters。

不同 instance 是隔離世界，不互通 monsters 或 eligibility；party membership 可跨 instance 保留。初期全房同步 public entities，不實作 complex area-of-interest service。個人 loot 不屬於 public monster collection，僅向 owner 傳送。

同 monster HP=0 只能進一次 RewardPending，凍結 contribution／eligibility，再經 reward commit 進 Dead／RespawnWait。Return／room disposal 是無 reward 的 reset；新 generation 不重用舊 ID。Room／monster 不跨 process restart 持久化。

## 考慮過的方案

- **Private PvE**：容易實作與分獎，但直接違反共享 combat 與 party 目標。
- **全世界共用單一 monster pool**：跨 room／node coordination 成本過高，且20人 map instance 已足夠 MVP。
- **共享 monsters＋personal loot**：戰鬥合作成立，經濟 ownership 清楚，但需要 deterministic attribution 與 idempotent rewards。

## 影響

Server 必須處理 simultaneous hit、overkill、aggro tie、contribution reset、late join／reconnect。共享怪物可能被不同 parties 競爭；用單份 BaseEXP pool attribution 與每人 personal loot 定義結果，不新增 last-hit ownership。

## 驗證與重評

M3.3 就用同 monster ID／HP fixture 驗證；M4 完成三 archetypes；M6 驗證 competing parties；M8.1／M8.3 驗證20人與≤12 monsters每 combat room 的成本。Future Boss 仍可使用同 encounter boundary，不在 MVP 建立 Boss 系統。

相關文件：[GAME_DESIGN §5–§7](../GAME_DESIGN.md)、[ARCHITECTURE §6–§7](../ARCHITECTURE.md)、[ADR-004](004-party-exp-and-personal-loot.md)。
