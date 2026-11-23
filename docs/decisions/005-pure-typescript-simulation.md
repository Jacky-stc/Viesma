# ADR-005 — 使用 pure TypeScript simulation 與 custom physics

- 狀態：Accepted，Task 0 架構基線。
- 日期：2026-11-23。
- 適用範圍：domain models、fixed-step simulation、physics、combat 與 pure reward policies。

## 背景

Server 要驗證 movement 與共享 combat，client 要做 local movement prediction，tests 要在無 renderer／network 的環境重播。若核心邏輯直接使用 React state、Pixi Sprite、Colyseus Schema 或 DB entity，simulation 很難獨立運行與控制測試時序。

## 決策

使用 explicit Player／Monster／Map／Attack／Contribution models 與小型純運算 modules。Simulation 固定30Hz，time、RNG、ID／definitions 由呼叫端提供；custom 2D platformer physics 只處理既定 AABB／one-way 範圍。不引入 generic ECS framework。

Domain／physics／game-data／simulation 不依賴 React、PixiJS、Colyseus、Drizzle、DOM 或 Node I/O。Server application orchestration 管理 sessions、party service、transactions 與副作用；transport／rendering 使用投影及 DTO。Repository ports 放在純 domain/application boundary，PG adapter 實作它們。

Shared packages 可包含 damage／EXP 的純函式與資料，以利 tests 與 preview；client bundle 中存在同公式不代表擁有 authority。Loot seed／credentials 僅在 server application，不編入 shared data。禁止直接 `Math.random()`／wall clock 進 simulation。

## 考慮過的方案

- **Engine-bound simulation**：原型快，但 Node reuse／prediction／tests 需維護平行規則。
- **Generic ECS**：可支援大型 entity 組合，本 MVP 沒有足夠需求證明其 abstraction／tooling 成本。
- **全 integer lockstep world**：增加 physics 開發成本；本案只需可重播測試與 server correction，無 P2P bit-exact lockstep。

## 影響

需要自行維護少量 physics／state machine。使用 JS number、stable iteration 與1/1024座標量化，配合 golden traces；不承諾跨 build／runtime 的 bit-identical full-world state。Combat RNG 由 server 決定，economy 數量與 EXP 使用整數及 safe-range validation。

未來 Boss／dungeon 可新增 explicit encounter policy／entity behavior，不以未來需求預先建立通用系統。

## 驗證與重評

M0.2 加 boundary／cycle checks；M1.1–M1.2 驗證 physics／controller 重播；M3.2 驗證 client reconciliation；M4／M6 用 injected RNG／clock 驗證 race 與 reward 不變量。若需新的 geometry 或 gameplay 組合，先擴充小型 modules，再用實際成本評估是否需要 framework。

相關文件：[ARCHITECTURE §2–§5](../ARCHITECTURE.md)、[AGENTS](../../AGENTS.md)。
