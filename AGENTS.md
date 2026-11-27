# 專案協作規範

本專案為原創 2D 橫向多人 RPG。所有協作者與 coding agent 均適用本文件。產品範圍見 [PRD](docs/PRD.md)，規則見 [GAME_DESIGN](docs/GAME_DESIGN.md)，技術契約見 [ARCHITECTURE](docs/ARCHITECTURE.md)，執行順序見 [ROADMAP](docs/ROADMAP.md)。

## 1. 當前階段與範圍

- Task 0 的交付是規格基線，當時所有實作任務從 `NOT_STARTED` 起算。現行進度以 [ROADMAP](docs/ROADMAP.md) 的任務狀態為準。
- 後續一次處理一項已授權的 roadmap task；先檢查 dependencies 與 acceptance criteria，避免自行擴張 milestone。
- 不加入 Redis、Kubernetes、microservices、generic ECS、交易、Boss、dungeon 或完整 quest 系統，除非需求明確改變並記錄 ADR。
- 保持原創；每項外部資產須記錄來源、作者、license 與 attribution，不使用未取得權利的 MapleStory 素材。

## 2. 程式與 TypeScript 規範

- 使用 pnpm workspace、ES modules、TypeScript；不混用 package manager。套件版本在 M0.1 驗證相容性後固定，提交 lockfile 的動作須另有使用者授權。
- `strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`、`useUnknownInCatchVariables: true`；不得以關閉 strictness 解決型別錯誤。
- 跨 trust boundary 的輸入先做 runtime validation；`unknown` 經驗證後轉型。禁止沒有說明的 `any`、non-null assertion 與 `@ts-ignore`。
- 使用具名 domain type、discriminated union、明確 error code。對 ID、時間單位與數值範圍提供可識別型別；persistent 整數不得超出安全表示範圍。
- 以小函式與明確資料結構表達規則；不為未出現的需求建立 framework、plugin system 或抽象 base class。
- 命名使用 English：type/class 為 PascalCase，function/variable 為 camelCase，常數依既有專案規範。文件與解釋性註解使用繁體中文。
- ESLint 管理 correctness 與 import boundary，Prettier 管理 formatting。M0.1 才建立實際設定；先檢查已有設定，保留既有慣例。
- UI 新增尺寸預設使用 `rem`；simulation 的 world unit、Tiled 座標與 canvas backing resolution 不屬於 CSS，使用明確的 world/render 單位。

## 3. Module boundaries

- `packages/simulation` 不得 import React、PixiJS、Colyseus、Drizzle、Node.js I/O、DOM 或 `apps/*`。時間、RNG、ID 由呼叫端注入。
- `packages/physics` 為純運算；`packages/game-data` 為可驗證的靜態定義；`packages/protocol` 只定義 wire contracts，不建立 runtime authority。
- `packages/network-colyseus` 處理 Schema 與 adapter；Schema 不可成為 simulation 的 domain model。
- `apps/client` 管理 React UI、Pixi rendering、input、prediction 與 interpolation，不能決定命中、EXP、AP、loot 或 inventory 結果。
- `apps/server` 擁有 map runtime、PartyService、command coordination、combat/reward authority 與 authentication；只有 persistence adapter 可以直接存取資料庫。
- `packages/persistence` 負責 Drizzle schema、migration 與 repository implementation；不得反向依賴 server 或 rendering。repository port 放在 application/domain 邊界。
- package 透過公開 exports 互動，不使用另一 package 的私有檔案相對路徑，不產生循環依賴。實際 package tree 以 ARCHITECTURE 為準。

## 4. 必須維持的不變量

- 單一角色、monster、reward 與 inventory mutation 只有一個 authority；async callback 不得繞過 command queue 直接改狀態。
- Server 驗證 movement input、cooldown、hitbox、AP、owner、capacity 與 session epoch。不得相信 client 回報的 damage、position、EXP、drop 或 item count。
- Monster death、reward grant、pickup 與 command retry 均有穩定 idempotency key；先 commit durable state，再通知成功。
- 所有相關 persistent mutation 使用 transaction；角色鎖按 `characterId` 排序。不得用「Node.js 單執行緒」取代 async race 與 DB concurrency 的處理。
- EXP 必須符合 GAME_DESIGN 的 group allocation、eligibility 與 rounding 規則；不可向每個獨立 group 重複發放完整 BaseEXP。
- 個人 loot 資料只能傳給 owner；在 client 隱藏 sprite 不算權限控管。
- 所有平衡數值集中於 game-data，記錄 `balanceVersion`；變更公式必須同步規格與測試。

## 5. 測試與驗證

- 使用 Vitest 驗證純 simulation、physics、combat、AP、party、EXP、loot 與 inventory 的行為及不變量。時間與 RNG 必須可重播。
- 網路測試涵蓋 stale/duplicate input、reconciliation、map transfer、reconnect、duplicate session、20-player room 上限與 owner-only payload。
- Persistence 使用真實 PostgreSQL integration tests；mock transaction 無法證明 unique constraint、rollback、row lock 或 retry 的正確性。
- 核心測試包括 simultaneous lethal hit、overkill、competing groups、idle member、roster change、rounding、duplicate pickup、full inventory、crash-after-commit 與 commit acknowledgement 遺失。
- Desktop keyboard 與 mobile landscape touch 需實際互動驗證；frame rate、tick cost、bandwidth 與 load test 須記錄環境、樣本與結果。
- 執行適合變更的檢查；正式功能 task 完成前跑對應 typecheck、lint、test、build 與該 task 指定驗證。不為純文件或低風險排版變更新增模仿實作的測試。
- 測試失敗或未能執行時，記錄原因及未驗證範圍；不得宣稱通過。不得在沒有驗證證據時將 task 標為完成。

## 6. 任務工作流程

1. 讀取本文件、相關規格與 ADR，確認 task ID、dependencies、scope 及目前 repository 狀態。
2. 若文件有矛盾，依使用者最新指示處理，再更新共同規格；不以暗中修改遊戲規則解決實作困難。
3. 以最小可驗證增量實作。跨 package、schema、protocol 或權限的變更先更新設計契約。
4. 執行 task 要求的測試與人工驗證，記錄結果、限制及新增風險。
5. 同步更新 roadmap 狀態、相關文件與 ADR；交付檔案、行為、驗證證據與未完成事項。

- 任務狀態為 `NOT_STARTED`、`IN_PROGRESS`、`LOCAL_VERIFIED`、`DONE`、`BLOCKED`。有阻礙時記錄影響、未驗證範圍與解除條件。
- 獲授權提交實作時，必要本機驗證完成後在實作提交記錄 `LOCAL_VERIFIED`。其餘必要驗收與該實作提交的遠端 CI 通過後，才另以純文件提交記錄 `DONE`，連結實作 SHA 與 workflow。純狀態更新沿用實作提交的驗收證據，即使文件提交也觸發 CI。
- 每項驗證記錄指令、環境與版本、結果、量測條件、限制及待驗證項目。詳細紀錄依 milestone 收錄，ROADMAP 保留證據連結。歷史紀錄保留當時結果，後續 CI 另附已確認的提交與 run。 [證據索引](docs/evidence/README.md)

## 7. 文件維護與 Git workflow

- PRD 定義「做什麼與驗收」；GAME_DESIGN 是平衡及遊戲規則的單一來源；ARCHITECTURE 定義 ownership、protocol 與 transaction；ROADMAP 定義依賴和交付；ADRs 記錄取捨。
- 跨文件引用使用相對連結；公式、名稱與 ID 保持一致。未定事項須有暫定值、負責決策的 task 及影響，不能留無法實作的空白。
- 修改既定架構決策時新增 superseding ADR，保留歷史，不直接抹除原因。
- 在適用的現有 checkout 作業，保留他人改動；不執行 destructive reset、未授權刪除或強制 push。
- **不自動建立 commit 或 push**。只有使用者明確要求時才提交，且先檢視 diff 與檢查結果；subject 使用簡潔 Conventional Commit 格式。
- 不把 credentials、token、原始密碼或 production dump 放入 repository、log 或測試 fixture。

### Test Infrastructure Guidelines

- Prefer existing test helpers and fixtures before introducing new ones.
- Keep test setup explicit when ordering, timing or fault injection affects correctness.
- Extract shared helpers only when their semantics are genuinely equivalent.
- Every standalone test tool must have a documented execution entry point and purpose.
- Temporary reproduction scripts should be retired after equivalent regression coverage and reproducible historical evidence are established.
- Prefer typed test infrastructure for complex shared state and metrics.
- Do not reduce regression coverage merely to reduce file count or lines of code.
- Keep test and development tools outside production runtime and bundles.