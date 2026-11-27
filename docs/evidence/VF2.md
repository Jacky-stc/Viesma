# VF.2 驗證紀錄

以 VF.1 `LOCAL_VERIFIED` 的工作樹為基線。正式任務進度維持 29／46。六張原始 PNG 的 SHA-256 驗收前後一致，原始來源檔留在 `art/source/environments/forest-entrance/`。 [VF.1](VF1.md) · [來源與署名](../../content/assets/provenance/forest-entrance.md)

## L5 前景

VF.1 以地圖底緣 Y=1024、Y 位移 100 和縮放 0.72 定位整張 2172 × 724 圖。原圖 `α > 0` 的內容邊界為 `[0,25,2172,724)`，`α ≥ 16` 為 `[0,196,2172,597)`。當 Y 因子為 1 時，較明顯像素最高可到 Y=743.84，超出主地板 Y=896，且整個畫面寬度都可鋪排。

VF.2 改用 `ground-band`，Y 位移 80，X 因子 1.1、縮放 0.72、不透明度 0.64 與水平重複沿用 VF.1。繪製矩形以同一個相機投影兩段地板，裁至 X=[0,1248) 與 [1432,4096)、Y=[928,1024)。首層 32 world units 草面留給 L4。紋理只取繪製矩形與實際圖的交集，整條裂隙、薄平台與地面以上空間保留原畫面。兩個 quad 共用一張原圖與水平相位。 [視差配置](../../apps/client/src/rendering/forest-parallax.ts) · [投影運算](../../apps/client/src/rendering/parallax-layout.ts)

## L4 素材稽核

原圖 1536 × 1024，8-bit RGBA，2,472,022 B。採逐片框選，邊界為左上包含、右下排除。下表九片的 `α ≥ 16` 內容外框皆觸及框選四邊，透明外距均為 0／0／0／0。平台的透明落在部分下緣，實際採樣的上 12 列都有有效像素。

| 部件     | 原圖裁切 `[x0,y0,x1,y1)` | 像素尺寸 | 框內全透明率 |
| -------- | ------------------------ | -------- | ------------ |
| 地板左端 | `[48,65,136,153)`        | 88 × 88  | 0%           |
| 地板中段 | `[145,55,241,151)`       | 96 × 96  | 0%           |
| 地板右端 | `[669,63,761,155)`       | 92 × 92  | 0%           |
| 平台左端 | `[826,52,918,144)`       | 92 × 92  | 0.39%        |
| 平台中段 | `[983,48,1079,144)`      | 96 × 96  | 1.17%        |
| 平台右端 | `[1148,50,1239,141)`     | 91 × 91  | 0.01%        |
| 土層     | `[146,171,242,267)`      | 96 × 96  | 0%           |
| 底部左角 | `[41,277,133,369)`       | 92 × 92  | 0%           |
| 底部右角 | `[556,277,638,359)`      | 82 × 82  | 0%           |

另外稽核內角及四個裝飾候選。下表外距以 `α ≥ 16` 計、順序為左／上／右／下。內角只會用在實際內凹接面，藤蔓、岩石、菇叢與灌木留在接觸表。斜面與懸垂完整剪影也保留在原圖。

| 候選 | 原圖裁切              | 透明外距   | 全透明率 |
| ---- | --------------------- | ---------- | -------- |
| 內角 | `[43,169,137,263)`    | 0／0／0／0 | 0%       |
| 藤蔓 | `[23,700,134,846)`    | 3／5／3／2 | 41.43%   |
| 岩石 | `[522,701,756,831)`   | 1／4／6／4 | 28.68%   |
| 菇叢 | `[761,734,872,810)`   | 4／3／5／5 | 16.05%   |
| 灌木 | `[1062,704,1276,813)` | 2／5／2／5 | 20.74%   |

[帶標示的接觸表](vf2/terrain-contact-sheet.png) · [切片 manifest](../../content/assets/forest-terrain-slices.json)

## 紋理與實際世界尺寸

每個方形來源裁切以 Lanczos 等比縮為 32 × 32 像素。接觸表比較了 64 px 候選，64 px 放大看草葉細節較清楚，32 px 可直接透過現有 Tiled 匯入器及對應的 32 world unit 格線。衍生圖的拼接端融合 3 px，土層兩軸外邊對接。每框周圍外擴 2 px，採 nearest sampling，3 × 3 圖集為 108 × 108，margin 2、spacing 4。在實際使用的圖塊區域逐像素檢查無 alpha 0，最小 alpha 為 229。

實驗遊戲與預覽共用 Forest Entrance 的地形 view。它將既有碰撞矩形的上緣、左／右端、內部及底角對應到直切圖塊。餘寬與餘高以 atlas 子圖框裁切，仍維持原圖像素到 world unit 的比例。atlas 由 M2.4 map scope 持有，切圖先銷毀 sprite 和 subtexture，再釋放 atlas 的 TextureSource 與 ImageBitmap。正式建置與未啟用實驗的遊戲使用原灰盒。 [M2.4 地形登錄](../../content/assets/experimental-terrain.json) · [外部 Tiled tileset](../../content/assets/images/forest-terrain.tsj) · [Tiled JSON](https://doc.mapeditor.org/en/stable/reference/json-map-format/#tileset)

## 權威地圖比對

現有 Tiled 地圖檔、匯入器、碰撞及伺服器程式皆沿用基線。單元驗證比較 client 圖塊矩形與七個正規化碰撞矩形的逐 world unit 覆蓋範圍，確認精確一致且圖塊互不重疊。另把 32 px 外部 tileset 與一個視覺 cell 送入既有匯入器，正規化物件資料與基線逐欄相等。 [地形測試](../../apps/client/test/forest-terrain.test.mjs)

| 碰撞             | VF.1 與 VF.2 的 (X, Y) | VF.1 與 VF.2 的寬 × 高 |
| ---------------- | ---------------------- | ---------------------- |
| 西岸實體地板     | (0, 896)               | 1248 × 128             |
| 東岸實體地板     | (1432, 896)            | 2664 × 128             |
| 西側實體踏台     | (640, 816)             | 226 × 24               |
| 東側實體踏台     | (1920, 816)            | 256 × 24               |
| 西側單向平台     | (384, 824)             | 168 × 12               |
| 裂隙單向平台     | (1280, 824)            | 120 × 12               |
| 東側樹冠單向平台 | (2152, 744)            | 248 × 12               |

主地板裂隙仍為 X=[1248,1432)。正規化快照保留 portal、角色出生點、怪物出生與巡邏及 loot fallback。角色碰撞盒繼續為 24 × 48 world units。完整 mapContentHash 為 `ee0a09e481b4d09daa529cf85a08cb7764685edf809f348a6c2dc62dbe94d5aa`。

## Chromium 畫面

桌面瀏覽器 1440 × 1000、DPR 1，預覽畫布 1280 × 720。手機為 667 × 375 橫向觸控模擬、DPR 2。裂隙對照的相機為 X=840、Y=370、zoom=1，高台對照為 X=1680、Y=490、zoom=1.35。用開關前景的截圖做像素差分，容許 2 CSS pixels 的相機邊緣取樣誤差，兩個位置在地板區帶外的差異點都是 0。腳點案例在同一 renderer 以固定畫面輸入檢查站立的 Beginner、場景原有 Slime sprite 與一個測試金幣投影，三者都落在草面上緣。 [瀏覽器案例](../../tests/visual/parallax.spec.mjs)

| 驗證場景                     | 實拍                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 預覽工具及開關               | [桌面](vf2/preview-desktop.png) · [手機橫向](vf2/preview-mobile.png)                                               |
| 西岸長地板、地面與高台       | [桌面遊戲](vf2/forest-desktop.png) · [手機橫向遊戲](vf2/forest-mobile.png)                                         |
| 東岸傳送回來的視角           | [東側遊戲](vf2/forest-east.png)                                                                                    |
| 裂隙的左／中／右段與前景邊界 | [地形與裂隙](vf2/gap-foreground.png) · [地形加碰撞疊圖](vf2/gap-collision.png) · [同鏡頭灰盒](vf2/gap-graybox.png) |
| 東側兩個不同高度的平台       | [高台與前景](vf2/raised-platforms.png)                                                                             |
| 玩家、Slime、掉落與草面      | [腳點近照](vf2/forest-footing.png)                                                                                 |

草面邊界與懸空平台尺寸受現有碰撞限制，薄平台保留上 12 px，完整懸垂根系留在來源。長地板的土層花紋及部分餘寬裁切可看出重複。L5 於地板局部範圍裁切後仍有可見剪影邊緣。L0–L3 沿用 VF.1 預設，L1／L2／L5 的接縫問題仍留存。 [VF.1 接縫](VF1.md#原始素材稽核)

## 下載、記憶體與效能

L4 圖集 SHA-256 為 `8dc974119e42ebbbc0b07d71ce187044a6735f526dd8715df92170060df4eb31`，下載 20,682 B，單份 RGBA8 為 46,656 B（0.0445 MiB）。L4 加五張視差合計 6,314,671 B，單份 RGBA8 為 31,497,216 B（30.04 MiB）。估算涵蓋圖像尺寸，CPU ImageBitmap、canvas buffers、瀏覽器額外配置與既有角色圖集另計。

Windows 11 build 26200、Intel Core i7-1355U、Node.js 24.22.3、pnpm 11.19.0、PixiJS 8.23.0、Playwright 1.65.1、Chromium 159.0.8154.6。所有圖層載入後在預覽開啟水平自動移動，以 rAF 間隔取樣約五秒。WebGL renderer 回報 ANGLE／Google SwiftShader Vulkan。

| SwiftShader 軟體渲染 | 幀間隔樣本／秒 | FPS  | p50／p95 幀間隔 |
| -------------------- | -------------- | ---- | --------------- |
| 桌面畫布／DPR 1      | 40／5.017      | 7.97 | 133.2／233.4 ms |
| 手機橫向畫布／DPR 2  | 37／5.133      | 7.21 | 133.3／266.7 ms |

[桌面原始樣本](vf2/swiftshader-desktop.json) · [手機橫向原始樣本](vf2/swiftshader-mobile.json)

以 `VIESMA_PARALLAX_HARDWARE=1` 在同機啟動 Chromium，WebGL renderer 回報 Intel Iris Xe Graphics／ANGLE Direct3D11，兩項預覽案例通過。兩組數字來自同一台 Windows 主機，橫向測試使用 Chromium 的 DPR 2 觸控模擬。行動真機及長時間樣本待量測。

| Iris Xe／D3D11 硬體渲染 | 幀間隔樣本／秒 | FPS   | p50／p95 幀間隔 |
| ----------------------- | -------------- | ----- | --------------- |
| 桌面畫布／DPR 1         | 300／5.000     | 60.00 | 16.7／16.9 ms   |
| 手機橫向畫布／DPR 2     | 300／5.000     | 60.00 | 16.7／17.0 ms   |

[桌面原始樣本](vf2/d3d11-desktop.json) · [手機橫向原始樣本](vf2/d3d11-mobile.json)

## 自動化回歸

- Focused Vitest 45／45，全量 Vitest 611／611（42 檔）。`pnpm run typecheck`、`pnpm run lint`（含套件邊界）、`pnpm run format:check` 通過。
- `pnpm run validate:assets` 驗證 7 個原有 sprite、9 個 L4 圖塊與 5 張實驗視差。 `pnpm run validate:maps` 通過七張地圖與 12 個方向的傳送門，hash 與 VF.1 基線一致。
- `pnpm run build` 通過。正式發行目錄只有原有三張 atlas 與署名，現有主 chunk 660.26 kB（gzip 196.29 kB），仍達到 Vite 的 chunk 大小提示門檻。
- `VIESMA_PARALLAX_PORT=4185 pnpm exec playwright test --config playwright.parallax.config.mjs` 完整重跑 8／8。開發測試用 4185，原本已有服務使用 4175。西側三次鍵盤往返、一次橫向觸控、鍵盤跳過裂隙到 Deep Forest 後回 M1 皆沿用同一 canvas。每次離開 M1，5 張視差及 1 張 L4 的 ImageBitmap、WebGL texture 和視覺物件歸零。首輪在 Deep Forest 回 M1 碰到 5 秒圖層就緒逾時，將 Chromium 載入等待延至 15 秒後，獨立與完整重跑皆通過。
- `git diff --check` 通過。以 `Get-FileHash` 比對六張原始 PNG，均符合 VF.1 摘要。遠端 CI 待實作提交。

正式版相關 Chromium 回歸 7／7（單 worker、約 1.3 分鐘、`VIESMA_SERVER_PORT=25825`），包含 Village 冷載入、資產缺失回退、橫向觸控走訪與跳躍、DPR／resize、七圖 12 向傳送、150 ms RTT 雙瀏覽器傳送與重連。

```powershell
$env:VIESMA_SERVER_PORT = '25825'
pnpm exec playwright test tests/smoke/world.spec.mjs tests/smoke/assets.spec.mjs tests/smoke/input.spec.mjs tests/smoke/shell.spec.mjs tests/smoke/multiplayer.spec.mjs --grep 'keyboard visits all twelve|missing optional atlas|cold-load budget|touch to walk between Village|supports movement with jump|two-browser slice at 150 ms|resizes the same canvas' --workers=1 --reporter=line
```

## VF.2 變更檔案

- 渲染與預覽。`forest-terrain.ts`、`forest-parallax.ts`、`parallax-layout.ts`、`parallax-renderer.ts`、`world-graphics.ts`、`world-renderer.ts`、`parallax-preview.tsx`。 [Renderer](../../apps/client/src/rendering/) · [預覽](../../apps/client/src/playground/parallax-preview.tsx)
- 資產。`asset-manifest.ts`、`asset-project.ts`、`forest-terrain-slices.json`、`experimental-terrain.json`、`slice-forest-terrain.py`、`images/forest-terrain-atlas.png`、`images/forest-terrain.tsj`、`provenance/forest-entrance.md`。 [資產工具](../../apps/client/tools/) · [素材目錄](../../content/assets/)
- 驗證與文件。`forest-terrain.test.mjs`、`parallax.test.mjs`、`parallax.spec.mjs`、`playwright.parallax.config.mjs`、`VISUAL_FOUNDATION.md`、`ARCHITECTURE.md`、`ASSETS.md`、`TILED_MAPS.md`、`ROADMAP.md`、`evidence/README.md`、本頁與 `evidence/vf2/`。 [測試](../../apps/client/test/) · [證據](vf2/)
