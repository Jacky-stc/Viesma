# Game data 載入與版本

[GAME_DESIGN](GAME_DESIGN.md) 定義初始平衡。`@viesma/game-data` 提供 schema v1、可重建的初始 fixture 和 `loadGameData(input: unknown, tiledExports?: unknown)`。Data 為純 TypeScript，由呼叫端提供。Server 在建立 transport 和監聽連接埠之前驗證資料，CI 由既有 Vitest 流程驗證同一份 fixture。有 Tiled 內容的呼叫端可在相同載入步驟傳入匯出檔。載入成功後才會取得唯讀的 `tiledMaps`。

| 欄位 | 契約 |
| --- | --- |
| `schemaVersion` | 初始為 `1`。文件形狀或欄位語意有不相容變更時提高版本。載入器只接受目前版本，舊資料須明確更新。 |
| `balanceVersion` | 初始為 `mvp-1`，是整份內容的穩定版本標籤。變更已發布的資料或平衡時更新標籤，部署時整份換版。 |
| `mapContentHash` | 以 UTF-8 編碼的 canonical manifest JSON 計算 SHA-256，表示為 64 碼小寫十六進位字串。包含 tile size、respawn、地圖基本資料、spawn ID、portal、怪物配置摘要及已匯入的正規化地圖。有匯入內容時加入 `tiledMaps` 欄位，空集合沿用 M0.4 的序列化。 |
| `protocolVersion` | 由 `@viesma/protocol` 定義。M3.2 的本人 movement checkpoint 使用 `2`，M3.3 的公開怪物投影與角色世代欄位使用 `3`。Wire contract 有不相容變更時提高版本。 |

Server 和 client 共同使用 `loadGrayboxGameData` 載入隨程式發布的七張 Tiled JSON。Server 以 `serializeMapManifest` 計算入房版本的 hash。M3.1 接入 transport admission，`checkJoinVersion` 對 protocol、balance、map hash 依序精確比對。版本以部署為單位更新。

## 資料與 ID

- `initialPhysicsBalance` 提供角色碰撞尺寸、跑速、加減速、重力、跳躍速度、下降終端速度、void 深度、跳躍緩衝、coyote 與 Hurt 時間。`loadPlayerMovementBalance` 驗證這份獨立的純 TS 設定。M1.2 啟用 [GAME_DESIGN §2](GAME_DESIGN.md#2-角色移動與狀態) 已列的初值，沿用 `mvp-1`。Tiled 匯入器共用角色尺寸及 M1.1 的碰撞驗證。
- `initialPlayerLifecycleBalance` 以 `loadPlayerLifecycleBalance` 驗證 Beginner Lv1 的 MaxHP 50、MaxMP 30、受傷免疫 30 ticks、重生延遲與保護各 90 ticks。M1.5 啟用 GAME_DESIGN 已列的初值，沿用 `mvp-1`。
- `playgroundSafeHub` 保留給 M1.5 的單圖測試。M2.2 的測試場從正式圖的 `village/spawn_respawn` 開始，死亡也回到同一點。
- 初始 fixture 描述七圖、六條雙向連線、建議等級與怪物群組。`loadGrayboxGameData` 要求七份 Tiled JSON 都通過 manifest 和幾何驗證，並核對各圖的怪物出生物件數與群組配置。`tiledMaps` 提供碰撞、出生點、傳送觸發區、巡邏／飛行區、NPC、掉落備援點及圖層。 [Tiled 地圖製作指南](TILED_MAPS.md)
- `loadGrayboxGameData` 也驗證 Guide 設定的穩定 ID、正整數互動半徑和非空白對話，並將其連結到 Village 的正規化 `npc_guide` 點。缺少該點時，發行資料驗證失敗。初始 96 world units 沿用 `mvp-1` 的設計基線。點位隨正規化地圖納入 `mapContentHash`，對話文字與距離設定隨 build 發布。 [Guide 設定](../packages/game-data/src/guide.ts)
- `progression` 包含等級上限、每級 AP、EXP 係數與按目前等級排列的表。載入器核對 `coefficient × L × (L + 1)`，並算出到頂累計 EXP 及 AP。Fixture 用同一份係數與等級上限產生表。
- `monsters` 包含 Slime、Mushroom、Bat 的 Lv1 初值、移動與傷害類型、掉落表和素材。等級縮放以整數基點表示，載入時檢查最高等級的計算結果及 EXP 分配乘積的安全上限。
- `items` 區分消耗品、素材、裝備。裝備槽的資料 ID 為 `weapon`、`armor`、`accessory`。`equipmentTiers` 提供各層級的三槽測試定義。`lootTables` 描述各自獨立的掉落項目，機率單位為基點，`10000` 代表 100%。固定物品與素材的數量區間最多一疊，裝備 tier 指向三個同級、槽位相符的物品。

內容 ID 用穩定的小寫 ASCII 字串，各類別使用不同型別。Portal 與 spawn ID 各自在地圖內唯一，loot entry ID 在表內唯一。Runtime 的 `monsterId`、`lootId`、`mapInstanceId` 以及 `characterId`、`itemInstanceId` 等持久識別由各自的 owner 配發。

一般數量以有號 32-bit 整數的非負範圍驗證，欄位可再縮小範圍。Schema v1 的等級上限最多 1000，裝備單項加成最多 1,000,000，暴擊加成使用基點範圍。這些是載入器的安全上限，初始遊戲值由 fixture 設定。

## 更新資料

1. 對照 [GAME_DESIGN](GAME_DESIGN.md) 更新 `packages/game-data/src/fixture.ts`。維持既有 ID 對應的語意，新增定義時為該類別分配新 ID。同步更新引用和 `balanceVersion`。
2. 執行 `pnpm run test`。驗證失敗時依 `GameDataValidationError` 的 `code`、`path` 和訊息修正資料，例如 `world.maps[1].portals[0].destinationSpawnId` 指向未知 spawn。整份文件通過後，載入器才回傳獨立且遞迴凍結的資料。
3. 執行 `pnpm run build` 和 `pnpm run test:smoke`。本機執行 `pnpm dev` 會先建置 server 所用的資料和 protocol 套件，編輯資料後重新啟動 dev 入口。

Canonical manifest 由 loader 按 bytewise ID 排序地圖、portal、spawn，怪物群組按 archetype ID 及等級排序。正規化 Tiled 地圖按 map ID、tileset path、各類物件 ID 排序。Tile Layers 維持繪製順序，cells 維持列優先順序。GID 正規化成 tileset path、local tile ID 和翻轉旗標。輸出固定欄位順序，重排 JSON 鍵、碰撞物件或等價的 GID 分配會得到相同 hash。碰撞盒、spawn、portal trigger、atlas 路徑及格線描述納入 hash。圖片位元組與動畫由 [client 資產管線](ASSETS.md) 獨立驗證。M3.3 使用現有 `mvp-1` 資料中的 M1 `spawn_slime_1` 與 Slime 定義。 [房間怪物契約](ARCHITECTURE.md#7-shared-monster-與-reward-pipeline)
