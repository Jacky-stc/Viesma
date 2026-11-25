# PostgreSQL 契約 spike

2026-11-26 · [路線圖](../ROADMAP.md#postgresql-契約-spikem53-後) · [證據索引](README.md)

**建議 `PROCEED_TO_M5.4`**。M5.4 可沿用已驗證的記憶體 mutation 與 receipt 契約。原生 PostgreSQL 驗證顯示角色鎖、滿包交換及同鍵恢復可保留代表性行為。M7 仍須處理文字欄位的可表示範圍，以及同步 coordinator 到非同步 tick 的交接。

## 基線與重現

- 本機和 `origin/main` 的 M5.3 實作均為 `04bd15f25561af42ed14b35fd820386b2b3dde20`。`CI / verify` 通過，先將 M5.3 的工作樹文件更新至 `DONE`。正式進度 27／46，spike 另列。基線 529 項 Vitest，23 項 Chromium smoke。 [M5.3 驗收](M5.md#m53) · [遠端 CI](https://github.com/Jacky-stc/Viesma/actions/runs/45666407454)
- Windows 11 build 26200，Intel Core i7-1355U（12 logical CPUs），約 16 GiB RAM。Node.js 24.22.3、pnpm 11.19.0、Vitest 5.1.1、`pg` 8.23.1。資料庫回報 `PostgreSQL 18.7 on x86_64-windows, compiled by msvc-19.44.35229, 64-bit`，使用 loopback TCP、UTF-8 和 `READ COMMITTED`。只讀 aggregate 快照使用 `REPEATABLE READ READ ONLY`，避免角色列與物品列跨版本。
- 本機 Docker Desktop 有安裝，但 engine 的 API 探測逾時。使用 PostgreSQL 官方下載頁連結的 EDB 18.7 Windows binary ZIP，解壓到暫存目錄，使用 `initdb`、`pg_ctl`、`createdb` 建立一次性叢集。Compose 的既有設定用隨機密碼和 `POSTGRES_PORT=0` 通過 `docker compose config --quiet`。本機 Compose 啟停路徑因 engine 未回應而未實跑，M5.3 的遠端 health smoke 另有通過證據。 [PostgreSQL Windows 下載](https://www.postgresql.org/download/windows/) · [EDB binaries](https://www.enterprisedb.com/download-postgresql-binaries?lang=en)

在 repo root，用已固定的 Node.js／pnpm，安裝主 workspace 與隔離的 `pg` 依賴。預設沿用專案的 `compose.yaml`，需可用的本機 Docker engine。

```sh
pnpm install --frozen-lockfile
pnpm --dir tools/pg-contract-spike install --ignore-workspace --frozen-lockfile
node tools/pg-contract-spike/run.mjs
```

若使用原生 18.7，設定 `VIESMA_SPIKE_POSTGRES_BIN` 為含上述三個工具的絕對路徑，再執行同一命令。例如 PowerShell 可在當前 shell 設定以下環境變數。

```powershell
$env:VIESMA_SPIKE_POSTGRES_BIN = 'C:\path\to\pgsql\bin'
node tools/pg-contract-spike/run.mjs
```

啟動器會建立獨立 DB、使用者、隨機憑證與 loopback port。測試各使用獨立 schema。Compose 使用隨機 project name 並於結束移除該 project 的 volumes。原生路徑用 `pg_ctl stop -m fast` 後移除暫存叢集。測試入口和 dependency lock 在 `tools/pg-contract-spike`，workspace 和一般 Vitest 的設定沿用原值。Drizzle 的 catalog 保留至正式 M7。Spike 使用 pinned `pg` 直接觀察 SQL、SQLSTATE 與 COMMIT 回應。

## 記憶體與固定 tick 的前提

- `CharacterCoordinator.open()` 以 `characterId` 建立一次 starter，lease 保留至最後一個使用者釋放，釋放時連同 receipt 一起移除。待完成 EXP 保留角色 lease，EXP 以 deathId 識別。`InventoryRepository` 接受同步或 Promise，但現行 coordinator 依具體同步 memory 型別執行 `read`、`findReceipt`、`commit`、COMMIT 例外後的立即查詢和 `applyStats`。
- 記憶體 `commit` 在單一執行回合內查同角色 receipt，再比 expected version，驗證候選 inventory 和全域裝備 instance ID，最後發布讓 `read` 可見的凍結 state 與 receipt。以物件身分區分有變更和無變更。變更的 `CONFIRMED` 使版本加一，無變更成功及業務拒絕保留版本。Repository 層的 stale candidate 拒絕不產生 receipt。Coordinator 在已接受的新請求讀到 stale client version 時寫一筆未改變 state 的 `STALE_VERSION` receipt。相同 key 不同 fingerprint 拒絕，相同 payload 回傳原結案與版本。Owner snapshot 讀目前版本。
- AP 以四項 canonical delta 和原預期版本辨識，全數配置或拒絕。EXP 以凍結授予、deathId 及原數值辨識，純 domain policy 決定升級及 AP。兩者與 equip／grant 共用角色版本。固定 tick 依序接受 reward completion、處理房間交接、執行玩家 mutation、步進戰鬥。成功提交後才按目前角色 route 更新 maxima 並 clamp HP／MP。這次以背包、裝備及 purse 驗證持久化邊界，AP／EXP payload 與多人獎勵不在 spike schema 內。 [角色協調](../../apps/server/src/runtime/character-coordinator.ts) · [固定 tick](../../apps/server/src/runtime/world-coordinator.ts) · [持久化契約](../ARCHITECTURE.md#8-persistence-model-與-transaction-boundaries)

## 最小 schema 與交換策略

| 表 | 約束 |
| --- | --- |
| `characters` | `id` 主鍵，`bigint` 版本限 0..2⁵³−1，`integer` purse 限 0..2,147,483,647 |
| `items` | 角色外鍵，`(character_id, location)` 主鍵，0..23 代表背包，24..26 代表三個裝備槽。全域 `instance_id` 唯一，stack 用 NULL。數量 1..99，instance 數量必須是 1，裝備槽必須有 instance。Metadata 用 `json` object。定義、等級、metadata 欄位與堆疊政策沿用 domain 驗證。 |
| `command_receipts` | 角色外鍵，`(character_id, request_key)` 主鍵，保存 canonical fingerprint、原 code、是否變更與結果版本。測試使用代表 play lease 的穩定 scope，真實 lease 和舊連線 epoch 對應仍由 M7 決定。 |

已佔用的裝備、背包位置以 immediate uniqueness 保護。兩筆逐列 `UPDATE` 的第一筆，以及用 `CASE` 的單一 `UPDATE`，都在滿包交換收到 `23505`。Spike 採先刪除受影響槽位、再依 domain 結果插入相同 instance ID 的 rows。持有角色鎖，同一 transaction 一併寫版本、purse 與 receipt，外部讀者只見提交前後。跨角色 instance 重複時用 savepoint 回滾 inventory SQL，版本不動並寫 `INVALID_ITEM` 結案。

另以 `DEFERRABLE INITIALLY IMMEDIATE` 槽位主鍵，在指定交易延後 uniqueness、原地交換。獨立讀者仍見舊位置，COMMIT 成功後兩件裝備各僅有一處。留下重疊時 COMMIT 本身失敗並回滾。刪後重插簡單且能維持 immediate 約束，會重寫受影響 rows，未來若有 item row 的 FK、trigger 或 audit 需評估。延後檢查可保留 row identity，需要 M7 決定 slot key 的形狀及採用延後檢查的範圍。 [Schema](../../tools/pg-contract-spike/schema.sql) · [PostgreSQL SET CONSTRAINTS](https://www.postgresql.org/docs/18/sql-set-constraints.html)

## 交易、重送與可觀察結果

| 契約 | 分類 | 證據 |
| --- | --- | --- |
| Starter 初始化 | `VERIFIED` | 兩連線競爭，第三方從 `pg_blocking_pids()` 觀測等待。提交前讀不到角色，提交後只有一角色、兩疊藥水和一件裝備，版本 0。 |
| 同角色鎖、版本、獨立角色 | `VERIFIED` | 以 application barrier 持有 `FOR UPDATE`，觀察到第二個 backend 被阻塞，同時第三連線可寫另一角色。兩個 expected version 0 的請求得到一次版本 1 及一筆 `STALE_VERSION`。後續非 client 版本型 grants 依序累加，資產沒有遺失。Commit／rollback 都釋放鎖。100 ms `lock_timeout` 得 `55P03`，無成功結果。 [PostgreSQL row locks](https://www.postgresql.org/docs/18/explicit-locking.html) |
| Packing、滿包、唯一性、purse | `VERIFIED` | 多疊按順序填滿，正規化 metadata 不受欄位順序影響。容量不足拒絕整批，滿包可交換，滿包 unequip 拒絕。SQL 拒絕重複 instance／位置、未知 owner、不合法數量、版本與 purse。 |
| Mutation 與 receipt 原子性 | `VERIFIED` | 改過物品及版本後、插入 receipt 後各拋一次錯，獨立連線確認兩者未改變。同鍵重試提交一次。並行相同 payload 在角色鎖後讀回原 receipt，異 payload 拒絕。資料庫主鍵跨連線保護同一角色的 receipt。同鍵重送不再加物品或貨幣。 |
| 應用層提交確認遺失 | `VERIFIED` | `COMMIT` 成功後才在回傳前拋錯。使用新連線、重建 repository，在較新版本提交後仍取回第一次的結果與版本，重送不覆寫新版。 |
| TCP 中斷與未知 COMMIT | `VERIFIED` | Loopback PostgreSQL wire proxy 收到 backend 的 `CommandComplete(COMMIT)` 後，在轉送給 driver 前斷 TCP。執行端只見連線錯誤，健康連線讀回同一 receipt。另以 DB barrier 驗證交易仍未結束、後續 commit 與 rollback 三種觀察結果。 [PostgreSQL protocol](https://www.postgresql.org/docs/18/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-COMMANDCOMPLETE) |
| 記憶體／PG parity | `VERIFIED` | 使用現有 memory repository 和 coordinator 比對 starter、堆疊、容量、裝卸、跨 owner 的正常 instance ID、currency 界限、noop、accepted/rejected code、receipt、版本、重送、conflict 和回滾可見性。以下另列文字欄位的邊界差異。 |
| 非同步 tick | `VERIFIED` | 隔離 harness 每角色依序 dispatch，等待資料庫時仍 tick，其他角色先提交並於 tick 套用。應用只消費新版本結果，重複、過期與 rollback 不發布成功；送往現行角色，保留 transfer／reconnect 路由及即時 HP／MP，已死角色未被復活。 |
| 本機 Compose 啟動 | `BLOCKED` | Compose 設定通過，Docker engine 探測逾時。以同版本原生 PostgreSQL 完成交易驗證。 |
| 新 lease、process restart、遠端 failover／TLS、耐久與容量 | `INCONCLUSIVE` | 本次是單機、單主庫、測試 play lease；未驗證正式 ownership、重啟、TLS、中途 primary 故障、資料耐久或負載。 |

### COMMIT 恢復

1. **COMMIT 前故障**。測試確認 rollback 完成後，健康連線取得同角色鎖再查仍無 receipt。重試保留原 ID 和 fingerprint。
2. **資料庫已提交、應用確認遺失**。`afterCommit` 拋錯驗證應用邊界。另由 TCP 測試切斷成功提交的伺服器回應路徑，涵蓋 driver 真的失去連線的情況。
3. **原交易仍可能完成**。先以健康連線讀 receipt。若未命中，嘗試有限時間取得同角色 row lock，並在 `READ COMMITTED` 的下一 statement 讀 receipt。等待太久回 `unresolved`，停止此輪處理。確認原 transaction 結束後才判斷已有 receipt 或已取得鎖仍無 receipt。此案例的原 transaction 在送出 COMMIT 前已持有同一角色鎖。恢復路徑不執行經濟 mutation，也不產生新 request ID。

M7.4 應補測送出前斷線、送出後結果尚未確定時中斷 backend／primary、TLS／pool 丟棄及重建連線、process crash、DB 恢復、deadlock retry budget、failover 與讀路由。結果未知的查詢應讀目前 write authority，避免 replica lag 被誤判為 rollback。仍須確認未確定工作在 queue／lease 中如何標記、何時停止接受新操作，以及與購買、拾取、多人獎勵的整合。

## 非同步固定 tick

Harness 以 30 Hz interval 測試。Admission 記錄 gameplay 條件及角色 ID，database dispatch 後持角色鎖注入 200 ms 延遲，commit 後 callback 只送入 completion queue，下一個 tick 才將新版本投影至現行角色。最終一輪 T+215 ms 內執行 4 次 tick，另一角色在等待期間已提交並投影。原先已接受的同角色請求依序完成，死亡後的新 admission 拒絕。重連只更新路由，測試比較的是同一角色跨路由的 economy、HP 0、即時 MP 及更晚完成的版本。

M7.4／M7.5 尚須設計 lease drain、進行中 transfer 的持有權、舊 lease 回呼與新 actor 的 fencing、死亡與 respawn 的 body generation，以及按效果類型在目前 tick 決定是否套用。對消耗品，以既有規格的 durable 扣量與一次性即時效果為準，待 M5.4／M7.4 驗證真正的指令與死亡交錯。Harness 無 Redis、world runtime 或 potion effect，時鐘觀察不能外推正式 tick 容量。

## 契約差異與 M7 決策

| 分類與嚴重度 | 重現、預期與實際 | 最小修正及影響 |
| --- | --- | --- |
| `CONTRACT_CHANGE_REQUIRED`，中，M7 非同步接入 | 將會回 Promise 的 adapter 接進現行 `createCharacterCoordinator`。預期 commit 後依序發布，目前函式要求 `MemoryCharacterRepository`，捕捉例外時同步查 receipt 並在同一回合更新 stats。非同步不可直接依賴這些保證。Harness 驗證 per-character dispatch、completion queue 與版本守門可行。 | M7.4 在 authority queue 定義 admission／durable outcome／tick application 三個時點，提供有界恢復與 lease fencing。M5.4 的記憶體接入可沿用既有介面，無需改 production contract。 |
| `CONTRACT_CHANGE_REQUIRED`，低，M7 文字相容性 | `insert` 的 metadata 值含 U+0000 或未配對 surrogate，記憶體會接受。預期選擇的持久化格式可 round-trip。`jsonb` 分別給 `22P05`／`22P02`，spike 的 `json` 串起 Node.js 的 JSON 編解碼可正常 round-trip。另以含 U+0000 的 `itemInstanceId` 重現，記憶體確認插入，PG `text` 給 `22021` 並回滾。 | M7.1 規定 server 發出的 ID 格式並在 boundary 驗證，或對 opaque ID 編碼；metadata 選保留轉義的格式，或經明確契約縮限及測試。M5.4 的物品使用既有 game-data 與 server 識別碼，這項邊界差異不阻擋。 |

M7.1 應以實際 schema 驗證 unique bag／equipment locations、各 ID 格式、metadata round-trip、transactions 與 migration／restore。M7.3 應把重送身分錨定在 durable lease，對應現行 `requestEpoch`，重連可查回原有 receipt。M7.4 應把 per-character queue、lock order、timeout、receipt recovery 與 tick application 接上正式 gameplay，並證明事故後只發放一次。 [ADR-006](../decisions/006-postgresql-persistence.md) · [M7.4](../ROADMAP.md#m74--atomic-economy-transactions-與-idempotency)

## 收據成長與容量 spike

- 現行 memory 每角色持有一份 receipt map，成功和可結案的拒絕都會成長，直到角色最後一個 lease 釋放。重送相同 key 不新增 row。高頻失敗但可結案的請求也會消耗空間。現行 request ID 高水位無法替代既有 receipt 的 canonical payload、原結果與版本。
- 1,000 筆同角色樣本，每筆代表短 play-lease key 與 equip fingerprint，平均 tuple 135.2 bytes，heap 147,456 bytes，主鍵 index 122,880 bytes，合計約 270 bytes／row。這次未計 WAL、索引 bloat、vacuum、連線或記憶體配置。以 1 筆／秒粗估約 23.4 MB／日／角色，實際需依接受及拒絕比率、key 長度和 session 壽命量測。
- 早期容量 spike 記錄各階段 receipt 筆數及新增／重送率，和 memory heap、角色釋放及 backlog 對照。M7 安全窗須覆蓋尚可重送的整個 epoch，並沿用已關閉 epoch 滿 30 天才可清理的規格。若刪除仍可接受的 ID，首次請求與歷史重送無法區分，可能重新扣量或發放。測試沒有設置 TTL 或 eviction。 [保留規則](../ARCHITECTURE.md#83-recovery-與-冪等) · [容量 spike](../ROADMAP.md#容量-spikem55-後)

## 驗證結果

- **PG spike**。`node tools/pg-contract-spike/run.mjs` 使用獨立 Windows PostgreSQL 18.7 叢集通過 16／16，Vitest 耗時 9.68 秒，叢集隨後停止並移除。並行本機檢查時一次 `initdb` 遇到原 30 秒上限，啟動器將初始化上限調至 90 秒。TCP 故障測試最初通過 assertions 但 `pg` 另發出預期的 connection `error` 事件，修正後同時斷言 query rejection 與事件，最終執行無未處理錯誤。
- **原有檢查**。`pnpm run test` 529／529（34 檔）、`pnpm run typecheck`、`pnpm run lint`（含 `check:boundaries`）、`pnpm run format:check`、`git diff --check` 均通過。獨立依賴的 frozen install 通過。正式環境檔案、正常 Vitest 與 CI workflow 維持既有設定。
- **基線驗收沿用**。`pnpm run build` 於實作 spike 前的同一 HEAD 通過。`pnpm exec playwright test --list` 收集 23 項，執行結果沿用 M5.3 及其遠端 CI。這次沒有重跑完整 Chromium 或 10 分鐘耐久。 [M5.3 驗收](M5.md#m53)
