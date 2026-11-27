# Tiled 地圖製作指南

M2.1 的匯入入口是 `loadGameData(source, tiledExports)`。每筆 export 提供 `{ mapId, map, tilesets }`，其中 `map` 是已解碼的 Tiled JSON，`tilesets` 以地圖宣告的外部路徑為鍵、對應已解碼的 tileset。載入成功後才會回傳遞迴凍結的 `GameData.tiledMaps`。CLI 在外層負責讀檔及算 hash。資料 schema、版本和 hash 見 [GAME_DATA](GAME_DATA.md)。

## 七圖 graybox

七個 JSON 檔同時是編輯來源和程式讀取的匯出。Village 分別直達 M1、M2、M3、M4，M5 經 M1 往返，M6 經 M2 往返。每張地圖的尺寸、建議等級和 portal／spawn ID 矩陣見 [遊戲設計 §1](GAME_DESIGN.md#1-世界與單位)。

| 地圖來源 | 地形與走訪方式 |
| --- | --- |
| [Village](../packages/game-data/src/maps/village.json) | 地板連續，從左往右依序通往 M3、M1、M2、M4。保留原本的露臺與單向平台，`spawn_respawn` 在 M3 與 M1 之間。 |
| [M1 Forest Entrance](../packages/game-data/src/maps/m1.json) | Village 門在西側，M5 門在裂隙東側。跑跳到較高的單向橋面，再持續向對岸移動。從西岸 x 約 1190 或東岸 x 約 1490 起跳即可落到橋面，直接走下缺口會墜落。 |
| [M2 Eastern Plains](../packages/game-data/src/maps/m2.json) | 寬闊地面連接西側 Village 門和東側 M6 門，沿途有離地矮台及可往上跳的瞭望平台。 |
| [M3 Rocky Hills](../packages/game-data/src/maps/m3.json) | 西側平地有返村門，往東可從矮石台跳上中段及山脊，另有靠地面的凸台。 |
| [M4 Underground Cave](../packages/game-data/src/maps/m4.json) | 西側有返村門，洞頂連至地圖上緣，狹窄路段仍留足角色可通行的淨空。從踏階可跳上兩端的窄平台。 |
| [M5 Deep Forest](../packages/game-data/src/maps/m5.json) | 西側返回 M1。地面貫通，西側根台、中段樹枝與東側分層踏面提供數條向上的路徑。 |
| [M6 Ancient Ruins](../packages/game-data/src/maps/m6.json) | 西側返回 M2。沿西側石階可跳上露台。東側祭壇前的裂隙寬 104 world units，兩側皆可用跑跳通過，從缺口墜落則會返村。 |

Graybox 用自製矩形呈現碰撞、平台與傳送區。戰鬥圖的巡邏區、飛行區和 Bat 掉落備援點在 Tiled 內可編輯，供後續怪物與掉落任務讀取。M2.3 已測試各圖出生點到各出口的實際跑跳、M2–M6 踏面落地，以及裂隙通行與墜落返村。

## Portal 與出生點慣例

- 來源門命名 `p_to_<目的 map ID>`，指向目的圖的 `spawn_from_<來源 map ID>`，並以 `reversePortalId` 指向回程門。保留既有 ID，位置可在不改變連線的前提下調整。
- 門的矩形底齊地板。出生點以腳底為基準，設在同一地板、門旁且在觸發區之外，留足 24 × 48 world units 的碰撞空間，再朝向地圖入口內側。
- 角色接地並與門重疊時，須新按 ↑／W 或觸控 ↑。換圖與回村沿用固定 tick 和同一個 PixiJS 畫布，並以新圖位置與邊界渲染。初次載入和死亡滿 90 ticks 後使用 `village/spawn_respawn`，死亡返村時補滿 HP／MP。 [遊戲規則](GAME_DESIGN.md#11-portal-與-spawn-契約) · [本地傳送契約](ARCHITECTURE.md#44-m22-本地地圖與傳送)

## 建立與匯出

1. 在 Tiled 建立 finite、orthogonal 地圖，render order 設為 Right Down，tile layer format 用 CSV（JSON 會輸出數值陣列）。地圖寬高（tile 數）對照七圖 manifest，tile 寬高使用 manifest 的 `tileSizeWorldUnits`，初始為 32 × 32。加上型別為 string 的 `mapId` 自訂屬性。
2. 如需圖塊，建立外部的單張圖 atlas tileset，tile 尺寸與地圖相同。將 tileset 存為 JSON（`.tsj` 或 `.json`）。`source` 相對於地圖檔，`image` 相對於 tileset 檔，以斜線分隔且位於各自檔案的目錄或其子目錄。匯入器驗證 atlas 描述、GID 範圍和 tileset 引用。資產 validator 核對 PNG 是否與版控登錄的 tile atlas 尺寸及位元組相同。 [視覺資產管線](ASSETS.md)
3. Tile Layer 可有多層，依檔案順序繪製，由下到上疊加。每層覆蓋整張地圖，陣列由左至右逐列填寫，`0` 為空。Object Layer 可有多層，名稱供編輯使用。以表中的類別建立物件並填寫屬性。Layer 位置及像素 offset 為 0，parallax 為 1，blend mode 為 normal。Object Layer 的可見性與 opacity 為編輯器顯示設定，其中的物件仍會匯入。
4. 用 **File → Save** 將編輯寫回原始 JSON，或用 **File → Export As** 試匯出至另一個目錄。檔名使用 `<mapId>.tmj` 或 `<mapId>.json`。支援 Tiled 1.10–1.12 的輸出（JSON `version` 為字串 `1.10`、`1.11` 或 `1.12`），物件的 class 會寫入 `type` 欄位。 [Tiled JSON 格式](https://doc.mapeditor.org/en/stable/reference/json-map-format/)
5. 執行 `pnpm run validate:maps` 驗證隨程式發布的七張圖。驗證試匯出時依下方範例提供七個路徑，將受測地圖的來源路徑換成對應的匯出檔。工具成功時輸出 `mapContentHash` 與正規化地圖。錯誤會顯示在 stderr 並傳回非零結束代碼，其中 `tiledMaps[i]` 對應輸入順序，並附 layer、object 或 property 路徑。建置後可直接執行 `node apps/server/tools/validate-maps.mjs` 取得純 JSON。

```powershell
$mapRoot = 'packages/game-data/src/maps'
$mapFiles = 'village', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6' | ForEach-Object { Join-Path $mapRoot "$_.json" }
pnpm run validate:maps @mapFiles
```

## 座標與物件

左上角為原點，右方為 +x，下方為 +y。1 Tiled pixel = 1 world unit。地圖範圍為 tile 數乘上 tile 尺寸。矩形的 x/y 為左上角，寬高均須大於 0。點的寬高均為 0。座標及尺寸須為 M1.1 的 1/1024 格線值，且幾何須落在地圖範圍內。匯入使用原值與精確的座標轉換，超界或不在格線上的值會報錯。

| Tiled 物件 class | 形狀 | ID 與屬性 | 驗證與正規化 |
| --- | --- | --- | --- |
| `SolidRect` | Rectangle | `name` 為 collider ID | 四面實體 AABB。 |
| `OneWayPlatform` | Rectangle | `name` 為 collider ID | 上緣為水平支撐面。沿用 M1.1 的單向下落碰撞。 |
| `PlayerSpawn` | Point | `spawnId`、`facing`（`left`／`right`）均為 string | 點為腳底中心。角色 AABB 左上角為 `(x − 寬/2, y − 高)`。初始角色寬 24、高 48，整個碰撞盒須在圖內，腳底與支撐面接觸，碰撞盒內須有淨空且避開 portal。 |
| `Portal` | Rectangle | `portalId`、`destinationMapId`、`destinationSpawnId`、`reversePortalId` 均為 string | Trigger 可貼齊地面，內部須避開實體幾何與 one-way 頂面。ID 及三個引用須與 manifest 相符。 |
| `MonsterSpawn`（地面） | Point | `spawnId`、`monsterArchetypeId`、`floorId` 為 string，`level` 為 int，`patrolMinX`／`patrolMaxX` 為 int 或 float | 腳底和整個水平巡邏段須在指定 collider 的頂面上，且段內無實體阻隔。 |
| `MonsterSpawn`（飛行） | Rectangle | `spawnId`、`monsterArchetypeId` 為 string，`level` 為 int | 飛行範圍內無實體碰撞，以矩形中心為出生點。地圖上須有 `LootFallback`。 |
| `Npc` | Point | `name` 為 NPC ID | 位置須在地圖內並離開實體內部。發行版 Village 必須有 `npc_guide`，點位同時是 Guide 的腳底繪製錨點與距離判定基準。 |
| `LootFallback` | Point | `name` 為 fallback ID | 點為腳底中心，須在 solid／one-way 頂面的水平內側，提供玩家碰撞盒淨空。只有地面怪的地圖可沿用已驗證的 `PlayerSpawn` 腳底中心，優先使用 `spawn_from_village`。 |

每張地圖的 Tiled layer ID 與 object ID 各自唯一。Stable ID 使用小寫 ASCII 字母、數字、底線及連字號，開頭須為字母或數字。Collider、spawn、portal、NPC、loot fallback 各自有地圖內 ID 空間，玩家與怪物共用 spawn ID 空間。怪物型態由 archetype 定義，配置須在 manifest 的類型、等級和數量範圍內。Village 不可含怪。M2.1 允許先匯入尚未放滿怪物標記的 graybox。

Manifest 驗證目的地、出生點 ID、反向關係與從 Village 出發的圖論可達性。每張供應的地圖均須含有 manifest 列出的 player spawn 和 portal。通用匯入器支援製作中的部分圖檔，正式發行用的 `loadGrayboxGameData` 和 CLI 要求七圖、完整怪物配置及 Village Guide。角色能否走到實際觸發矩形，另以固定步進遊走和瀏覽器操作驗證。 [M2.5 驗收](evidence/M2.md#m25)

## GID 與未支援格式

圖層的 GID 使用 uint32。扣除最高四位再依 `firstgid` 找 tileset 和 local tile ID。H、V、D flags 個別保留，繪製時先套用 D，再套用 H、V。第 29 位是 Tiled 可能殘留的六角格旗標，orthogonal 圖中清除。有效 GID 須落在外部 atlas 的 tile 範圍。參考 [Tiled Global Tile IDs](https://doc.mapeditor.org/en/stable/reference/global-tile-ids/)。

不支援 TMX／TSX XML、非 orthogonal、infinite／chunks、base64／壓縮圖層、group／image layer、嵌入或 image-collection tileset、tile animation／每 tile 碰撞、非預設 offset／parallax／blend、物件旋轉、template、tile object、text、ellipse、capsule、polygon、polyline，以及表外的自訂屬性。其餘未知欄位會報錯。測試使用 [小型匯出 fixtures](../packages/game-data/test/fixtures/tiled)，含自製雙色 tile 圖與故意錯誤的 atlas 設定。

VF.2 提供可由既有匯入器讀取的 32 px、3 × 3 外部 tileset，`margin=2`、`spacing=4`。Forest Entrance 的既有碰撞含 off-grid X/Y 與 12／24 world units 薄面，實驗模式以 client 的圖塊矩形裁切對齊這些座標。同一 Tiled 地圖匯出繼續供遊戲、預覽與伺服器使用。 [實驗 tileset](../content/assets/images/forest-terrain.tsj) · [Visual Foundation](VISUAL_FOUNDATION.md)

VF.2.1b 的 client 自然地形依主地板 ID、實體或單向碰撞類型挑選部件，對齊原有上緣與水平跨度。來源區域和接點由開發 atlas 管線管理，Tiled 地圖持續提供碰撞、傳送、出生和巡邏資料。 [部件座標](../apps/client/src/rendering/forest-organic-terrain-slices.json) · [VF.2.1b 驗證](evidence/VF2.1.md)
