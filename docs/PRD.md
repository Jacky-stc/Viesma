# Web RPG 產品需求規格

文件版本：Task 0 / 2026-11-23。狀態：規格基線，尚未實作。專案暫稱 Viesma，正式名稱未定。規則以 [GAME_DESIGN](GAME_DESIGN.md) 為準，技術設計見 [ARCHITECTURE](ARCHITECTURE.md)，任務見 [ROADMAP](ROADMAP.md)。

## 1. 產品願景

建立可在 desktop browser 與 mobile landscape browser 遊玩的原創 2D 橫向 fantasy multiplayer RPG。借鑑經典 MapleStory 的探索、平台移動、打怪、成長與組隊節奏；角色、美術、地圖、音樂、名稱與內容均使用原創或合法授權資產。

第一個產品以可遊玩且可維護的 MVP 為目標：七張相連地圖、單一 Beginner class、共享怪物與 HP、2–4 人 party、個人 loot、等級與裝備成長、可靠的角色儲存。每個 map instance 最多 20 名角色，沒有大型 MMORPG 的跨服與營運系統。

主要體驗循環：登入與選角 → Village 準備 → portal 探索 → 移動／跳躍／攻擊共享怪物 → 獲得 EXP 與 personal loot → 分配 AP、使用藥水、整理及更換裝備 → 組隊挑戰較高等區域 → 死亡後回 Village，再繼續探索。

## 2. 使用者與交付階段

使用者為喜歡短時間探索與合作戰鬥的桌面／手機玩家。以單人即可開始、隊友可隨時加入的 PvE 體驗為優先。

| 階段 | 定義 | 明確界線 |
| --- | --- | --- |
| Early multiplayer vertical slice | M3：兩個 browser 在同一 map 移動、跳躍、看到同一隻測試怪物的 authoritative 狀態 | 使用 dev identity、簡化 monster、無完整獎勵；提早驗證網路與 simulation 邊界 |
| MVP-A | M6.5：本機單一 runtime 可完成完整 gameplay loop，含 party 規則的多角色測試 | in-memory repository、dev harness；不代表 production persistence 或對外 multiplayer 品質已達標 |
| MVP-B | M8.5：經過 authentication、PostgreSQL、多人整合、mobile 與 fault/load 驗證的 multiplayer release candidate | 單節點、有限容量的首發候選版本；仍不等同大規模 MMORPG |

MVP-A 可使用 early multiplayer adapter 進行開發展示，但不以真實帳號、多裝置可靠性或跨重啟保存為驗收承諾。完整 MVP 要求以 MVP-B 為準。

## 3. MVP 使用者旅程

| ID | 旅程與結果 | 驗收連結 |
| --- | --- | --- |
| J1 | 註冊／登入，建立 Beginner，選角進入 Village；再次登入可看到已提交的進度 | F01、F10、B1 |
| J2 | keyboard 或多點 touch 移動與跳躍，通過雙向 portal 到七張地圖，再返回 Village | F02–F04、A1、B3 |
| J3 | 多人攻擊同一 monster，看見相同 HP、死亡與 respawn；同一死亡只結算一次 | F05、F06、B2 |
| J4 | 邀請隊友、接受／拒絕、轉移 leader、離隊／解散；跨 map 保留 party，但 idle／遠離者不分 EXP | F07、A3、B2 |
| J5 | 獲得個人可見的 loot，拾取、堆疊、使用 consumable、equip／unequip，滿包時有明確失敗回饋 | F08、F09、A2、B4 |
| J6 | 升級取得 5 AP，server 驗證分配；HP 歸零後在 Village respawn | F06、A2 |
| J7 | 斷線於 grace window 內回到同角色；重複 session 被拒；request 重送不增加獎勵或物品 | F10、B4 |
| J8 | 與 Village NPC 對話，得知操作、組隊與 portal 用法 | F11、A1 |

## 4. Functional requirements

以下均為 MVP-B 必需；部分能力先以 MVP-A 的 in-memory adapter 完成。

| ID | 需求 | 可驗證結果 |
| --- | --- | --- |
| F01 | Account authentication、角色建立／選擇；每帳號最多 3 角色，只有 Beginner | 非本人角色無法選取；同帳號同時只有一個 play session |
| F02 | Village、M1 Forest Entrance、M2 Eastern Plains、M3 Rocky Hills、M4 Underground Cave、M5 Deep Forest、M6 Ancient Ruins | 七張皆可載入；Village 無 monster；等級區間與 topology 符合 GAME_DESIGN |
| F03 | 六條雙向連線、12 個 directed portal、有效 destination spawn | 無單向死路、spawn 不在碰撞體內；滿房保留來源安全位置並回報 |
| F04 | 左右移動、jump、gravity、solid／one-way platform collision；七種角色狀態 | Idle、Run、Jump、Fall、Attack、Hurt、Death 均有顯示與合法轉移 |
| F05 | 每 instance 最多 20 人、共享 monster HP、AI、spawn／death／respawn | 第 21 人不會進入滿房；所有連線看見相同 monster ID 與結果 |
| F06 | Server 驗證 basic attack、cooldown、hitbox、damage、EXP、level、AP；HP／MP 與 Village respawn | Client 不能直接指定結果；初始四屬性皆 4、level 1；每級 +5 AP |
| F07 | Party 2–4 人；invite、accept、reject、leave、disband、leader transfer；跨圖保留 | Eligible member 才分 EXP；competing groups 不重複領取 BaseEXP；公式可設定 |
| F08 | 個人 reward roll；currency、consumable、equipment、misc；loot ID、owner、expiry | 非 owner 收不到 loot payload，也不能拾取；重送 pickup 不重複增加 |
| F09 | 24 inventory slots；可堆疊 consumable／material；equipment 不堆疊；Weapon／Armor／Accessory | equip、unequip、consume、pickup 均驗證容量、ownership、level 與數量 |
| F10 | PostgreSQL 儲存 level、EXP、AP、base stats、currency、inventory、equipment；atomic reward／inventory | rollback 無半套結果；commit 後斷線／重啟不回退已確認的經濟狀態 |
| F11 | 至少一位 Village NPC，基本 dialogue | keyboard 與 touch 均能互動、關閉對話並繼續控制 |
| F12 | 傷害數字、hit／hurt／death、loot、level-up、錯誤與 reconnect 回饋 | Server 確認才顯示命中／收益成功；prediction 僅提供動作手感 |

## 5. Desktop 與 mobile 要求

### Desktop

- 支援 keyboard：ArrowLeft／A、ArrowRight／D、Space jump、J attack、E interact／portal、F pickup、I inventory、P party、K AP；1／2 使用指定 HP／MP 藥水。鍵位設定保留未來擴充點，MVP 不做自訂鍵位 UI。
- UI focus、dialogue 或文字輸入時不觸發遊戲操作；blur／visibility change 送出 neutral input，避免卡鍵。
- 參考 viewport 為 1280 × 720 CSS pixels；較小 desktop 至 960 × 540 可操作；UI 透過 scale／reflow 保持可讀。

### Mobile

- Landscape 主要遊玩，最低參考 viewport 667 × 375 CSS pixels。Portrait 顯示旋轉提示並停止本機 input；server 世界持續運作，不把 orientation lock 或 fullscreen 當必要條件。
- 左側方向控制，右側 jump、attack、interact／pickup、HP／MP 藥水；inventory、party、AP 使用可觸控面板，按鈕 touch target 至少 2.75rem。
- 支援左右移動＋jump／attack 多指同時操作；處理 `pointercancel`、gesture、safe-area、browser toolbar 變動與 app 切換。
- DOM UI 使用 `rem` 與 safe-area；Pixi scene 自行處理 logical viewport、camera、DPR 上限 2 與 resize。世界 physics 不受 CSS scale 或 refresh rate 影響。
- 支援 WebGL 的 browser 為基線；WebGPU 非必要。不能建立 renderer 時顯示明確支援訊息。
- M8.2 以當時 current／previous stable Chrome、Edge、Firefox、Safari desktop，以及實機 iOS Safari、Android Chrome 記錄實測版本。最低 OS 與裝置清單在 M0.1 暫定、M8.2 鎖定。

## 6. Non-functional requirements

以下為 release gate 目標，未達須修正或明確縮減承載量，不得以推測標示通過。

| ID | 項目 | 量測與目標 |
| --- | --- | --- |
| N01 | Server simulation | 30 Hz fixed timestep；參考 4 vCPU／8 GiB、單 Node process、PG 分離 container，同區域測試 7 rooms × 20 players、每戰鬥圖 ≤12 monsters，連續 60 分鐘；整個 process 每個 tick cycle p95 <20ms、p99 <33.33ms，無持續 backlog |
| N02 | Rendering | 參考 desktop 平均 ≥55 FPS；中階 mobile ≥30 FPS；20 players、12 monsters、傷害數字與 touch 同時存在，連續 10 分鐘記錄 frame time 與 memory |
| N03 | Network | 10 Hz authoritative patches、100ms interpolation buffer 初值；RTT 150ms／jitter 30ms／模擬 1% loss 下無持續 rubber-banding、重複 reward 或 input backlog；WebSocket 為可靠傳輸，loss 以 transport delay／disconnect 測試 |
| N04 | Bandwidth／下載 | 20 人 combat room 每 client 下行平均 ≤50 KiB/s、上行 ≤10 KiB/s；首個可操作 Village cold load ≤8 秒，基準 10 Mbps／RTT 100ms，初始必要壓縮資產目標 ≤5 MiB，後續 maps 延遲載入 |
| N05 | Correctness | 同 death 最多一筆 grant／recipient；同 loot 最多一次 pickup；AP、currency、stack 不為負；未提交結果不顯示已成功；DB retry 不複製進度 |
| N06 | Recovery | reconnect grace 30 秒；DB outage 停止 economy mutation 並有回饋；已確認 mutation 在 app process crash 後可恢復；備份／restore drill 驗證日備份 RPO ≤24h、RTO 目標 ≤2h |
| N07 | Security | TLS／WSS、opaque session、密碼 hash、CSRF／Origin、payload schema／rate limit、owner authorization、secret redaction；沒有 client-authoritative economy |
| N08 | Maintainability | 純 TS simulation 無 framework import；balance data versioned；CI typecheck／lint／tests／build／map validation；critical invariants 有可重播測試 |
| N09 | Feedback／可讀性 | DOM buttons 有可讀標籤與 keyboard focus；HP／party／error 不只靠顏色區分；不承諾完整 screen reader canvas gameplay |
| N10 | Observability | 記錄 tick cost、connections、room occupancy、reject／retry／duplicate／DB latency；log 可用 deathId／requestId 追蹤，不含密碼與 token |

單節點 launch admission cap 暫定 140 個 active／reserved unique characters、最多 14 rooms；transfer 的同一角色在 node 計數一次，但在來源／目的 room 各保留一個 seat。實際值由 M8.3 實測決定。20 人是每 room hard limit，不代表單節點容量已獲證明。

## 7. MVP-A acceptance criteria

Gate：M6.5。以 in-memory repository、local authority 與 scripted／headless 多角色完成；可重設資料。

- **A1 世界與操作**：Beginner 可在七張 Tiled maps 移動與跳躍；12 portals 雙向可達；Village 無怪；NPC dialogue；desktop 與 mobile landscape 操作完整。
- **A2 成長與物品**：三種 monster 具完整 AI／combat／respawn；打怪 → EXP → level-up → +5 AP → 合法分配；個人 loot → pickup → stack／consume／equip／unequip；滿包／死亡 → Village 均可重複操作。
- **A3 Party 與共享獎勵**：2–4 角色 invite／reject／accept／leave／leader transfer／disband、跨圖保留；mixed parties／solo、idle、距離、離隊及 rounding 符合共同規格，local harness 可重播。
- **A4 品質證據**：M0–M6 tasks 的 required tests 通過；M3 early multiplayer slice 已展示；禁止以此宣稱帳號安全、持久化、20 人穩定或 production-ready multiplayer。

## 8. MVP-B acceptance criteria

Gate：M8.5。MVP-A 全部條件，加上以下結果。

- **B1 帳號與儲存**：真實 authentication、角色建立／選擇；至少三次 logout／login 與一次 process restart 後已確認進度相同；非本人讀寫被拒。
- **B2 共享世界與 party**：20 clients 同 room、共享 monsters／HP／combat；21st seat 被拒或導向可用 instance；四人跨圖組隊與 competing parties／solo 分配通過整合測試。
- **B3 裝置與連線**：desktop keyboard、iOS Safari 與 Android Chrome 實機 landscape；切換 app／portrait／resize／掉線恢復；150ms RTT 情境下 prediction／reconciliation／interpolation 可操作。
- **B4 故障與 economy**：simultaneous lethal hits、duplicate requests、full inventory、session conflict、DB rollback、commit 後斷線／kill process 等測試無 duplication／已確認結果遺失；未拾取 ground loot 依 expiry／rebind 規則恢復。
- **B5 Release**：N01–N10 有結果紀錄；Docker／migration／rollback／backup restore／graceful drain 有 runbook 與演練；無未處理的 blocker；正式素材 license 完整。

## 9. 明確不在範圍內

多職業／轉職、skill tree、PvP、Boss encounter、party dungeon、guild、global chat、trading／auction、shops、advanced quests、crafting、cash shop、付費、email recovery、social login、character deletion／rename、離線收益、跨服、multi-node、無縫大世界、gamepad、native app、完整 anti-cheat client。可保留資料與介面延伸點，不能提前實作。

## 10. 暫定決策、風險與決策時點

| 議題 | 可實作預設 | 驗證／決策 task |
| --- | --- | --- |
| 美術與資產 | Task 0 不產生資產；初期原創 placeholder，所有外部資產附 license manifest | M2.4、M8.2 |
| Balance／難度 | Level cap 25、GAME_DESIGN 初始公式與掉落率；沒有 death EXP penalty | M5.1、M6.5、M8.3 |
| Auth／營運 | Username＋password，無 email；封閉測試帳號 recovery 由營運人工處理 | M7.2、M8.5；公開規模擴張前另立需求 |
| Hosting／database | 單 region、單 Node process、PostgreSQL persistent volume 或 managed PG；不依賴 Redis | M0.1、M8.4 |
| 裝置效能 | DPR ≤2、WebGL 基線、最低 viewport 667 × 375；實機清單尚待量測 | M0.1、M8.2 |
| 版本 | Stack 已定；Node／pnpm／Colyseus／Drizzle／PostgreSQL 的相容版本在 foundation 固定 | M0.1；本次不安裝 |

核心風險為 mobile touch／render 成本、網路預測偏差、party eligibility 邊界、跨 DB／runtime 一致性與單節點容量。M3 提早降低同步風險，M5–M7 先寫可重播與 transaction 驗證，M8 以實測決定首發容量。上述未定事項不阻礙 M0.1，但不得在 release gate 仍無紀錄。
