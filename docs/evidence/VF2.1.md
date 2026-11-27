# VF.2.1b Forest Entrance 自然地形驗證

以 VF.2 的工作樹為基線。VF.2.1b 已達 `LOCAL_VERIFIED`，待使用者視覺驗收。視覺審查使用同一個頁面、相機與 Pixi renderer 比較灰盒、VF.2 矩形和自然地形。正式 roadmap 進度為 29／46。 [Visual Foundation](../VISUAL_FOUNDATION.md) · [VF.2 基線](VF2.md)

2026-11-27 更新。使用者已視覺驗收 VF.2.1b，並指示延後其餘地形修整。延後項目包括長地板內接點與重複、薄平台輪廓、底緣露底、L1／L2 接縫及森林實機可讀性。下文保留原本的本機驗證紀錄。 [VF.3.1](VF3.md)

## 原始素材稽核

四張皆為 2172 × 724、8-bit RGBA。百分比以整張原圖計算。下列座標採左上包含、右下排除，透明外距依 `α ≥ 16` 的邊界計算，順序為左／上／右／下。原圖保留 SHA-256 對應的交件位元組。 [原始 PNG](../../art/source/environments/forest-entrance/organic-terrain/) · [來源與署名](../../content/assets/provenance/forest-entrance.md)

| 原圖 | 位元組 | SHA-256 |
| --- | ---: | --- |
| `main-ground.png` | 1,137,631 | `191c4f2868b3b52c5874b5951bfd2f958a57729fee3c31734fe73f32ec5f2ab4` |
| `ground-edges.png` | 1,311,647 | `a48016c8eeaf7e1713e72e528457b20f43a5f4157439a95f755859243a930662` |
| `thick-platform.png` | 1,138,801 | `8d18d5058373d2f9cb75587185792b6958f569089d912ca779dcd07385261a72` |
| `thin-platform.png` | 590,026 | `eef112e36b05f71653971045ca617e72deee8c8f7d8152223d1a37e6f3c23335` |

| 原圖 | `α=0`／`1–254`／`255` | `α≥16` | `α>0` 邊界 | `α≥16` 邊界 | 透明外距 |
| --- | --- | ---: | --- | --- | --- |
| 主地板 | 64.093／35.906／0.002% | 32.801% | [0,19,2172,724) | [0,228,2172,595) | 0／228／0／129 |
| 地板端蓋 | 57.111／42.888／0.001% | 40.014% | [0,15,2152,724) | [38,19,2120,708) | 38／19／52／16 |
| 厚平台 | 63.912／36.087／0.001% | 33.220% | [0,3,2160,724) | [45,124,2128,615) | 45／124／44／109 |
| 薄平台 | 83.969／16.030／0.001% | 13.765% | [27,29,2150,676) | [57,195,2115,548) | 57／195／57／176 |

主地板原圖左右已直切，原始邊欄的草線高度、土層深度與色調有落差。地板端蓋有完整的外緣和懸垂根系，朝內的一側可從平坦草面選欄。厚平台有飽滿土層和多處向下的根，薄平台主要是草和木質細條，葉片與藤蔓集中在局部。兩種平台中段的原始端點均收圓，薄平台尤其明顯，直接對接會露出背景。四張圖在主要剪影外都有低 alpha 雜點。 [原圖及衍生框接觸表](vf21/source-components.png)

## 部件與接點

表內範圍及草面 Y 都是原圖像素。接點是水平邊界 `x0` 或 `x1`，取樣分別使用第一欄或最後一欄。中段所列的完整擷取區就是可重複區域。畫面以草面錨點定位，植物頂端和藤蔓尖端保有自己的位置。 [切片資料](../../apps/client/src/rendering/forest-organic-terrain-slices.json)

| 部件 | 擷取範圍 | 原圖 `α≥16` 內容邊界 | 草面 Y | 左／右內接點 | Atlas px |
| --- | --- | --- | ---: | --- | --- |
| 地板左 | [36,15,908,711) | [38,19,908,708) | 175 | —／908 | 436 × 348 |
| 地板中 | [66,225,1910,597) | [66,228,1910,592) | 329 | 66／1910 | 922 × 186 |
| 地板右 | [1266,31,2122,705) | [1266,33,2120,703) | 175 | 1266／— | 428 × 337 |
| 厚平台左 | [42,121,504,613) | [45,124,504,610) | 227 | —／504 | 231 × 246 |
| 厚平台中 | [725,169,1543,545) | [725,171,1543,543) | 225 | 725／1543 | 409 × 188 |
| 厚平台右 | [1694,136,2130,618) | [1694,140,2128,615) | 226 | 1694／— | 218 × 241 |
| 薄平台左 | [54,192,504,550) | [57,195,504,548) | 292 | —／504 | 225 × 179 |
| 薄平台中 | [678,245,1102,445) | [678,248,1102,414) | 291 | 678／1102 | 212 × 100 |
| 薄平台右 | [1702,204,2118,492) | [1702,206,2115,490) | 292 | 1702／— | 208 × 144 |

地板、厚平台及薄平台分別使用 0.235、0.145、0.13 world units／原圖像素。地板中段常見土層約 40–55 world units，地板端蓋最深根尖約 125。厚平台中段的土層約 25–35，端蓋根尖約 56。薄平台主體約 8–12，最深根尖約 34。裂隙短平台用兩個完整薄端蓋等比放大約 6.6%。西岸與東岸地板分別使用兩段和五段完整中段，中段僅在水平方向配合剩餘寬度。全部七段共用 26 個 Sprite。

衍生圖清除 `α < 12` 的雜點，以 Lanczos 降至原始像素尺寸的一半，atlas 採線性取樣。依各類原始世界比例，每 world unit 約對應 2.13、3.45、3.85 atlas px。桌面與 DPR 2 橫向的正常視角都能看到草面細節及細藤蔓。

按世界 Y 對齊四條內接邊欄後，使用預乘 alpha 取共同剖面。每側修正寬度依地形類型為 8、6、4 atlas px，以二次衰減回到原色。生成器檢查所有內接點在錨點及接縫帶的草面 `α ≥ 240`，每個圖框外擴 2 px 防止相鄰圖框取樣串色。逐像素比對後，各類型四條內接邊欄相同，草面採樣的最小 alpha 依序為 252、253、252。以草面錨點同一列的 `α ≥ 128` 判定外端草緣，六個端蓋因自然彎曲，在碰撞端點內退約 0.5–8.5 world units。 [生成器](../../content/assets/slice-forest-organic-terrain.py) · [圖集登錄](../../content/assets/experimental-organic-terrain.json)

## 權威地圖

主地板、實體踏台與單向平台的碰撞上緣維持原座標。兩岸地板的中間區域 X=[1248,1432) 維持開放，裂隙單向平台獨立位於其上。背景 L0–L3 共用既有設定，L5、1.1 水平視差與前景區帶只在 VF.2 模式啟用。角色、怪物、掉落和戰鬥顯示均在地形前方。自然地形載入後隱藏灰盒地圖外框，以免外框在裂隙與根系下方形成視覺邊線。傳送門標記持續顯示，預覽可開啟碰撞疊圖。 [原始 Tiled 地圖](../../packages/game-data/src/maps/m1.json) · [佈局回歸測試](../../apps/client/test/forest-terrain.test.mjs)

| 承重面 | X, Y | 寬 × 高 | 顯示部件 |
| --- | --- | --- | --- |
| 西岸地板 | (0, 896) | 1248 × 128 | 主地板 |
| 東岸地板 | (1432, 896) | 2664 × 128 | 主地板 |
| 西側踏台 | (640, 816) | 226 × 24 | 厚平台 |
| 東側踏台 | (1920, 816) | 256 × 24 | 厚平台 |
| 西側枝台 | (384, 824) | 168 × 12 | 薄平台 |
| 裂隙跨台 | (1280, 824) | 120 × 12 | 薄平台 |
| 東側樹冠 | (2152, 744) | 248 × 12 | 薄平台 |

七圖正規化 `mapContentHash` 為 `ee0a09e481b4d09daa529cf85a08cb7764685edf809f348a6c2dc62dbe94d5aa`，與 VF.2 相同。七張 Tiled 地圖與十張森林原圖的 SHA-256 皆與開工前相符。`m1.json` 的 SHA-256 為 `17fd703e96227d6bf20afc2239be45958e1fbd17eef80598895e22bacd654ba5`。伺服器、物理、出生、傳送、巡邏和掉落配置沿用基線。

## Chromium 畫面

桌面畫布為 1280 × 720 CSS px、DPR 1，手機橫向為 Chromium 667 × 375 CSS px 觸控模擬、DPR 2。裂隙比較的預覽相機為 X=850、Y=605、zoom=1.65。東岸長段以 X=2510、Y=304、zoom=1 取景，內接縫以 X=2845、Y=788、zoom=3.2 取景。

| 畫面 | 截圖 |
| --- | --- |
| 裂隙同鏡頭對照 | [灰盒](vf21/gap-graybox.png) · [VF.2 矩形](vf21/gap-rectangular.png) · [自然地形](vf21/gap-organic.png) · [碰撞疊圖](vf21/gap-organic-collision.png) |
| 主地板及外端剪影 | [西端](vf21/west-cliff.png) · [東端](vf21/east-cliff.png) · [東岸長段](vf21/east-ground.png) · [中段內接點](vf21/east-join.png) |
| 四座側邊平台 | [西側](vf21/west-platforms.png) · [西側疊圖](vf21/west-platforms-collision.png) · [東側](vf21/east-platforms.png) · [東側疊圖](vf21/east-platforms-collision.png) |
| 遊戲與腳點 | [桌面西岸](vf21/forest-desktop.png) · [桌面東岸](vf21/forest-east.png) · [手機橫向](vf21/forest-mobile.png) · [Beginner、Slime 和測試金幣](vf21/forest-footing.png) |
| 預覽控制 | [桌面](vf21/preview-desktop.png) · [手機橫向](vf21/preview-mobile.png) |

長地板的岩石與植被存在固定間距的重複，高倍縮放可辨識接合處附近的色調和土層深度轉折。薄平台部分藤蔓低於碰撞底緣，左／右端的草葉會隨剪影稍微彎曲。低於主地板土層剪影的位置會露出背景，該區位於世界底緣，沒有下層遊玩路線。手機遊戲入口站位會和既有的觸控按鈕部分重疊。遠景 L1／L2 的既有背景接縫留待後續實機檢查。

## 下載與紋理記憶體

以實際下載的 PNG 位元組與單份 RGBA8 `width × height × 4` 估算。數字涵蓋該模式的森林背景與地形，不含 HUD、共用角色圖集、framebuffer、驅動配置或 CPU／GPU 同時持有的副本。

| 模式 | 森林 PNG | 下載 | 估計 RGBA8 |
| --- | ---: | ---: | ---: |
| VF.2 矩形 | 6 | 6,314,671 B | 30.04 MiB |
| VF.2.1b 自然地形 | 5 | 6,673,702 B | 27.71 MiB |

自然地形 atlas 為 1339 × 727，下載 1,042,176 B，估計 3.71 MiB，SHA-256 為 `0c2dd19bed6eb2f65821e81a7db24ae6920d8d630d315bf506a66f4ea450ee0d`。與 VF.2 相較，下載增加 359,031 B，單份解碼紋理減少 2.33 MiB。

## 硬體加速 FPS

Chromium WebGL 回報 Intel Iris Xe Graphics、ANGLE Direct3D11，驅動 32.0.101.7076。兩種模式各自從重設後的相同相機起點，以 zoom=1 開啟水平自動移動，待素材就緒並把 canvas 捲入視窗後，用 rAF 取樣約五秒。每種尺寸兩個模式皆約 60 FPS。手機列使用桌面 GPU 與手機橫向觸控模擬，實機及長時間畫面尚待檢查。

| 畫布 | 模式 | 樣本／秒數 | FPS | 幀間隔 p50／p95 | 原始樣本 |
| --- | --- | --- | ---: | --- | --- |
| 桌面 DPR 1 | VF.2 矩形 | 300／5.000 | 60.00 | 16.7／16.9 ms | [JSON](vf21/d3d11-desktop-rectangular.json) |
| 桌面 DPR 1 | VF.2.1b 自然地形 | 301／5.017 | 60.00 | 16.7／16.8 ms | [JSON](vf21/d3d11-desktop-organic.json) |
| 手機橫向 DPR 2 | VF.2 矩形 | 301／5.017 | 60.00 | 16.7／16.9 ms | [JSON](vf21/d3d11-mobile-rectangular.json) |
| 手機橫向 DPR 2 | VF.2.1b 自然地形 | 301／5.016 | 60.00 | 16.7／16.9 ms | [JSON](vf21/d3d11-mobile-organic.json) |

## 自動化驗證

環境為 Windows 11 build 26200、Intel Core i7-1355U、Node.js 24.22.3、pnpm 11.19.0、PixiJS 8.23.0、Vitest 5.1.1、Playwright 1.65.1、Chromium 159.0.8154.6。素材稽核與生成使用 Python 3.12.3、Pillow 10.3.0。

- `pnpm exec vitest run apps/client/test/forest-terrain.test.mjs apps/client/test/parallax.test.mjs apps/client/test/asset-manifest.test.mjs apps/client/test/asset-rendering.test.mjs` 通過 44／44。全量 `pnpm run test` 通過 614／614（42 檔）。
- `pnpm run typecheck`、`pnpm run lint`、`pnpm run check:boundaries` 通過。 `pnpm run validate:assets` 通過 25 個 sprite 與 5 張開發視差 PNG。 `pnpm run validate:maps` 通過七張地圖及 12 個方向的傳送門。
- `python content/assets/slice-forest-organic-terrain.py` 重新產出的 atlas 及登錄 SHA-256 均一致。 `pnpm run build` 通過，正式發行只供應原有三張 atlas 與署名。主 chunk 為 662.08 kB（gzip 196.95 kB），Vite 仍提示超過 500 kB。
- 在 4196 埠以 `VIESMA_PARALLAX_HARDWARE=1` 執行 `pnpm exec playwright test --config playwright.parallax.config.mjs --reporter=line`，通過 9／9。兩個聚焦 FPS 案例以畫布捲入視窗的取樣流程重跑，通過 2／2。PNG 缺失時可往返灰盒，正常遊走會載入四張背景與一張自然地形 atlas，未發出 L5 請求。預覽切換三種模式、桌面鍵盤三次返村、手機橫向觸控往返，以及按鍵跨裂隙進出 Deep Forest 均沿用單一 canvas。ImageBitmap 與 WebGL 活躍紋理離開 Forest Entrance 後皆還原，卸載場景後全部歸零。
- `pnpm run format:check` 與 `git diff --check` 通過。這份紀錄涵蓋本機驗證，遠端 CI 待實作提交。

正式建置的 Chromium smoke 通過 7／7，涵蓋冷載入、資產缺失回退、手機橫向走訪與跳躍、DPR／resize、七圖 12 向傳送、150 ms RTT 雙瀏覽器傳送與重連。

```powershell
$env:VIESMA_SERVER_PORT = '25835'
pnpm exec playwright test tests/smoke/world.spec.mjs tests/smoke/assets.spec.mjs tests/smoke/input.spec.mjs tests/smoke/shell.spec.mjs tests/smoke/multiplayer.spec.mjs --grep 'keyboard visits all twelve|missing optional atlas|cold-load budget|touch to walk between Village|supports movement with jump|two-browser slice at 150 ms|resizes the same canvas' --workers=1 --reporter=line
```

## 本次變更檔案

- Client 渲染與預覽。 `forest-terrain.ts`、`forest-parallax.ts`、`parallax-renderer.ts`、`world-renderer.ts`、`world-graphics.ts`、`assets/atlas-scope.ts`、`parallax-preview.tsx`。 [渲染程式](../../apps/client/src/rendering/) · [預覽](../../apps/client/src/playground/parallax-preview.tsx)
- 資產。 `forest-organic-terrain-slices.json`、`slice-forest-organic-terrain.py`、`experimental-organic-terrain.json`、`images/forest-organic-terrain-atlas.png`、`asset-manifest.ts`、`asset-project.ts`、`provenance/forest-entrance.md`。 [切片資料](../../apps/client/src/rendering/forest-organic-terrain-slices.json) · [資產](../../content/assets/) · [資產驗證](../../apps/client/tools/)
- 驗證與文件。 `forest-terrain.test.mjs`、`parallax.spec.mjs`、`VISUAL_FOUNDATION.md`、`ARCHITECTURE.md`、`ASSETS.md`、`TILED_MAPS.md`、`ROADMAP.md`、`evidence/README.md`、本頁與 `evidence/vf21/` 的 PNG 及 JSON。 [地形測試](../../apps/client/test/forest-terrain.test.mjs) · [Chromium 測試](../../tests/visual/parallax.spec.mjs) · [截圖與樣本](vf21/)
