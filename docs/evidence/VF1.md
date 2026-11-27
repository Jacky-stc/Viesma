# VF.1 驗證紀錄

工作基線為 `5b9b435`。既有 M1.3 camera／viewport 與 M2.4 資產管線是本次前置，VF.0 的方向記錄在 [Visual Foundation](../VISUAL_FOUNDATION.md#vf0-方向)。五張視差 PNG 只登錄開發用途，L4 留給 VF.2。原始 PNG 的 SHA-256 已鎖定。 [來源與署名](../../content/assets/provenance/forest-entrance.md)

## 原始素材稽核

於 2026-11-26 使用 Python 3.12、Pillow 10.3.0、NumPy 1.26.4 逐像素讀取六張 PNG。邊界使用左上包含、右下排除的 `[x0, y0, x1, y1)`。外距依左／上／右／下表示。`α = 0` 為完全透明，`0 < α < 255` 包含幾乎不透明的像素。另以 `α ≥ 16` 顯示較容易看出的內容外距。記憶體以 `寬 × 高 × 4 ÷ 2²⁰` 估算每份 RGBA8 紋理。

| 層／原圖                   | 尺寸        | 檔案（B） | 8-bit 色彩／alpha | 完全透明／部分透明 | 內容邊界 `α > 0` | 外距 `α > 0`／`α ≥ 16` | RGBA8 MiB |
| -------------------------- | ----------- | --------- | ----------------- | ------------------ | ---------------- | ---------------------- | --------- |
| L0 `forest-sky.png`        | 2172 × 724  | 1,566,801 | RGB／無           | 0%／0%             | [0,0,2172,724)   | 0/0/0/0／0/0/0/0       | 6.00      |
| L1 `forest-ruins.png`      | 2172 × 724  | 1,017,807 | RGBA／有          | 57.9374%／42.0585% | [0,9,2172,724)   | 0/9/0/0／0/201/0/113   | 6.00      |
| L2 `forest-far-trees.png`  | 2172 × 724  | 1,203,478 | RGBA／有          | 57.6761%／42.3140% | [0,9,2172,724)   | 0/9/0/0／0/194/0/130   | 6.00      |
| L3 `forest-near-trees.png` | 2172 × 724  | 1,843,440 | RGBA／有          | 35.3225%／64.6660% | [0,0,2172,724)   | 0/0/0/0／3/5/2/74      | 6.00      |
| L4 `forest-terrain.png`    | 1536 × 1024 | 2,472,022 | RGBA／有          | 38.1641%／61.8359% | [0,0,1523,1024)  | 0/0/13/0／23/16/17/43  | 6.00      |
| L5 `forest-foreground.png` | 2172 × 724  | 662,463   | RGBA／有          | 76.9857%／22.9935% | [0,25,2172,724)  | 0/25/0/0／0/196/0/127  | 6.00      |

L1–L5 的透明區來自 PNG alpha。以實色底合成檢查，沒有可見的烘焙棋盤格。有效內容多接近 `α = 250–253`。部分近透明散點使嚴格邊界接近整張畫布，L4 的最大 alpha 為 254。

接縫 MAE 先把左右最外一欄合成至 `#606060`，再對同列 RGB 計算通道平均絕對差。左右邊緣本來就透明的素材即使分數低，仍可能出現構圖間距或縫隙。

| 層  | MAE／p95（0–255） | 目視結果與處理                                                                              |
| --- | ----------------- | ------------------------------------------------------------------------------------------- |
| L0  | 11.4／21.6        | 雲帶和天空明度在接縫明顯跳變。預設使用單張等比 cover。若要重複，等化兩端雲帶與亮度。        |
| L1  | 2.7／11.1         | 廢墟外輪廓和霧色在接合處跳變。正式循環版需對齊外輪廓並延續底霧。                            |
| L2  | 1.2／7.1          | 林冠和樹腳的霧帶有輕微接痕。修整兩端林冠分布及樹腳 alpha。                                  |
| L3  | 0.1／0.5          | 兩端近透明，接合處呈自然的樹叢間距。大尺度移動仍可辨認重複樹形。                            |
| L4  | 0.0／0.0          | 整張是分散排版的圖塊來源。兩端透明，循環整張會重播整張圖塊表。VF.2 逐格切片並檢查圖塊對接。 |
| L5  | 2.2／8.6          | 接合處的枝幹併成一簇，根系輪廓與底部暗帶有接痕。修整兩端根系高度、剪影及 alpha。            |

[六層水平重複接觸表](vf1/horizontal-contact-sheet.png) · [L0–L3／L5 原圖疊合](vf1/source-composite.png)

## Chromium 驗證及截圖

Windows 11 家用版 26200、Intel Core i7-1355U、16 GB RAM、Node.js 24.22.3、pnpm 11.19.0、PixiJS 8.23.0、Playwright 1.65.1、Chromium 159.0.8154.6。`pnpm exec playwright test --config playwright.parallax.config.mjs --reporter=line` 以 Vite 開發伺服器、單 worker、headless Chromium 和 ANGLE SwiftShader 執行。桌面瀏覽器 1440 × 1000、DPR 1，預覽畫布 1280 × 720。手機瀏覽器以 667 × 375、DPR 2 和觸控模擬，預覽 backing canvas 1334 × 750。截圖使用 CSS 像素，並保留可捲動的控制面板及 HUD。

| 畫面                     | 桌面                            | 手機橫向                                 |
| ------------------------ | ------------------------------- | ---------------------------------------- |
| 預覽工具                 | [桌面](vf1/preview-desktop.png) | [667 × 375 觸控](vf1/preview-mobile.png) |
| Forest Entrance 遊戲場景 | [鍵盤](vf1/forest-desktop.png)  | [667 × 375 觸控](vf1/forest-mobile.png)  |

五項開發 Chromium 案例涵蓋兩種畫布尺寸和 DPR、相機負座標與縮放、圖層編輯、水平重複控制、複製／下載 JSON、重設與自動移動。Forest Entrance 檢查背景與 Beginner 的實際像素、HUD、單一 canvas、三次桌面往返與一次觸控往返。Village 初次載入沒有請求森林圖片。每次進入森林觀察到 5 份 ImageBitmap 與 5 份 WebGL texture，離開後皆為 0，卸載後既有圖集也清為 0。五個 PNG 請求皆回傳 404 的案例仍可走訪灰盒。 [瀏覽器案例](../../tests/visual/parallax.spec.mjs)

畫面仍可辨認灰盒地形和較小的 Beginner。入口右側的前景根系可在相機移動時看見重複，L1、L2、L5 接痕仍待處理。手機是橫向觸控模擬，控制面板可捲動，部分遊戲 HUD 位於首屏下方。WebGL 裝置的單張紋理上限若低於 2172 像素，原尺寸素材會略過並保留灰盒。

## 效能觀察

五張載入的原尺寸 PNG 共 6,293,989 B。RGBA8 單份估算共 29.99 MiB，未計入 CPU 上的 ImageBitmap、GPU／瀏覽器額外配置、canvas buffers 及原有圖集。

| 預覽自動移動              | 樣本／時長   | 平均 FPS | 幀間隔 p50／p95 |
| ------------------------- | ------------ | -------- | --------------- |
| 桌面 1280 × 720、DPR 1    | 37／5.050 秒 | 7.33     | 133.3／250.0 ms |
| 手機橫向 667 × 375、DPR 2 | 37／5.133 秒 | 7.21     | 133.3／266.6 ms |

五層載入後啟用水平自動移動，以 `requestAnimationFrame` 的時間戳取樣約五秒。這是 headless SwiftShader 的軟體渲染幀間隔，行動真機與硬體加速的 frame budget 待量測。 [桌面樣本](vf1/preview-desktop-perf.json) · [橫向觸控樣本](vf1/preview-mobile-perf.json)

## 自動化回歸

| 指令                                                                                                                                                                          | 結果                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run apps/client/test/parallax.test.mjs apps/client/test/asset-rendering.test.mjs apps/client/test/camera.test.mjs apps/client/test/asset-manifest.test.mjs` | 41／41，涵蓋排序、相機因子、resize／zoom、水平重複、失敗回退及反覆切換時的紋理共用與釋放。               |
| `pnpm run test`                                                                                                                                                               | Vitest 5.1.1，607／607（41 檔）。                                                                        |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run check:boundaries`、`pnpm run format:check`、`git diff --check`                                                               | 通過。                                                                                                   |
| `pnpm run validate:assets`                                                                                                                                                    | 7 個既有 sprite、5 張開發視差 PNG 通過驗證。六張原始 PNG 摘要與稽核前一致。                              |
| `pnpm run build`                                                                                                                                                              | 通過。發行目錄只有原有三份圖集與署名，`parallax.html` 和森林視差 PNG 只由開發伺服器供應。                |
| `pnpm exec playwright test --config playwright.parallax.config.mjs --reporter=line`                                                                                           | 開發版 Chromium 5／5。                                                                                   |
| `pnpm run test:smoke`                                                                                                                                                         | 正式版首輪 24／25，包含七圖 12 個方向的傳送門、DPR／畫布清理、素材回退與 150 ms RTT 雙瀏覽器傳送及重連。 |

正式版 smoke 以 `VIESMA_SERVER_PORT=2579` 執行。單人戰鬥案例首輪在 Playwright 路由處理報 `Fetch response has been disposed`。維持同一份正式建置，用 `pnpm exec playwright test tests/smoke/multiplayer.spec.mjs --grep 'plays the solo combat loop' --workers=1` 獨立重跑通過（1／1）。本次證據來自本機工作樹，遠端 CI 待實作提交。

`pnpm run validate:maps` 驗證七張地圖及 12 個方向的傳送門。用文件中的 `pnpm --filter @viesma/client run dev --port 4175 --strictPort` 啟動後，另重跑缺圖回退案例並通過（1／1）。Vite 正式建置報主 chunk 660.02 kB（gzip 196.21 kB），超過預設的 500 kB 提示門檻。

## 變更檔案

- 渲染與遊戲進入點。`world-renderer.ts`、`world-graphics.ts`、`camera.ts`、`forest-parallax.ts`、`parallax-layout.ts`、`parallax-renderer.ts`、`run-multiplayer.ts`。 [Renderer](../../apps/client/src/rendering/) · [多人進入點](../../apps/client/src/multiplayer/run-multiplayer.ts)
- 開發預覽。`parallax.html`、`parallax-preview.tsx`、`parallax-preview.css`。 [入口](../../apps/client/parallax.html) · [預覽控制](../../apps/client/src/playground/parallax-preview.tsx)
- 資產。`atlas-scope.ts`、`catalog.ts`、`texture-image.ts`、`asset-manifest.ts`、`asset-project.ts`、`validate-assets.ts`、`experimental-parallax.json` 與 `provenance/forest-entrance.md`。 [渲染資產](../../apps/client/src/rendering/assets/) · [驗證工具](../../apps/client/tools/) · [登錄](../../content/assets/experimental-parallax.json)
- 測試。`parallax.test.mjs`、`playwright.parallax.config.mjs`、`tests/visual/parallax.spec.mjs`、`tests/smoke/atlas-audit.mjs`。 [Vitest](../../apps/client/test/parallax.test.mjs) · [Chromium](../../tests/visual/parallax.spec.mjs)
- 規格與證據。`VISUAL_FOUNDATION.md`、`ARCHITECTURE.md`、`ASSETS.md`、`TILED_MAPS.md`、`ROADMAP.md`、`evidence/README.md`、本頁及 `evidence/vf1/` 的 PNG 和 JSON。 [Visual Foundation](../VISUAL_FOUNDATION.md) · [證據檔案](vf1/)
