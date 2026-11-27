# VF.3.1 靜態 Beginner 角色驗證

後續接入、比例稽核與比較畫面見 [VF.3.2a Base Body Integration](#vf32a-base-body-integration)。

2026-11-27。本機驗證完成，狀態為 `LOCAL_VERIFIED`，待使用者視覺驗收。以使用者已視覺驗收的 VF.2.1b 為基線。正式 roadmap 維持 29／46。 [Visual Foundation](../VISUAL_FOUNDATION.md) · [VF.2.1b](VF2.1.md)

## 2026-11-27 角色底模更新

工作區原圖已換為 1536 × 1024 的 8-bit RGBA 角色底模，SHA-256 為 `66d9c4ebeef10db49fd1495b23d5a091368f608d3e254a389ad0d3dc476f3bca`。可見輪廓（`α ≥ 16`）為 `(570, 204)–(943, 783)`，鞋底錨點為 `(740.5, 783)`。新版圖集為 180 × 256、45,405 B、估計 RGBA8 180 KiB，SHA-256 為 `081e71fe24bd2f56ba68e6fe3813cafcd8d2d2bf7423cadf614e4f513d8c4715`。

舊流程在 Vite 啟動時讀取圖集。重新生成角色圖集與登錄後，正在執行的開發伺服器會重載資產。實測 5173 的新雜湊 URL 回應 200，原雜湊 URL 回應 404，瀏覽器載入的 PNG 通過 SHA-256 比對。下列各節保留初版彩色角色的量測與畫面。 [現行角色來源](../../content/assets/provenance/beginner-character.md) · [現行開發登錄](../../content/assets/experimental-character.json) · [Village](vf3/replacement-village.png) · [Forest Entrance](vf3/replacement-forest.png)

Windows 11、Node.js 24.18.0、Pillow 10.3.0。資產驗證、client typecheck、相關 ESLint／格式檢查與 client 正式建置通過。聚焦 Vitest 通過 32／32。以 Playwright 1.65.1、Chromium 159.0.8154.6、Direct3D11 對 5173 執行角色套件，通過 4／4，涵蓋往返地圖與紋理釋放、缺圖回退、手機橫向與多人同房。

## 初版來源、輪廓與腳點

| 項目 | 量測 |
| --- | --- |
| 原始 PNG | 1312 × 1199、8-bit RGBA、994,590 B |
| 原圖 SHA-256 | `de2f0d8c4cbff59c592d5f597c879a800116f0c430f3374298e41e044303e6d5` |
| 原圖長寬比 | 1312:1199，約 1.094:1 |
| Alpha | 1,056,072 像素全透明，516,414 像素半透明，602 像素全不透明 |
| 非零 alpha 外框 | `(31, 12)–(1274, 1182)`，1243 × 1170 |
| 可見輪廓 | `α ≥ 16` 時為 `(265, 15)–(972, 1180)`，707 × 1165，約 0.607:1 |
| 鞋底錨點 | 原圖 `(668, 1180)`。鞋底帶 `1150 ≤ y < 1180` 的輪廓橫跨 `[509, 827)`，取該帶的水平中點與可見最低處的下緣 |

座標以左上包含、右下排除記錄。原圖完整保留。生成器先核對原圖摘要，清除低於 16 的 alpha，維持垂直可見輪廓高度，以腳點左右對稱取樣及保留必要透明量，用同一縮放倍率以 Lanczos 取樣兩個軸。原圖的畫布比例包含透明外距，遊戲保留其中角色輪廓的比例。 [原圖](../../art/source/characters/beginner/character-master.png) · [來源與署名](../../content/assets/provenance/beginner-character.md) · [生成器](../../content/assets/derive-beginner-character.py)

## 選用解析度與成本

比較 64、80 world units 且 1 CSS px／world unit、DPR 2 的顯示。128 px 在預設大小仍可辨識角色，於 80 world units 需放大至 160 個實體像素，眼鏡邊線和眼睛細節較柔。256 px 版在較大預覽尺寸保住細線與髮絲輪廓，因此供開發遊戲使用。 [128／256 比較圖](vf3/resolution-comparison.png)

| 版本 | 下載 | 單份 RGBA8 紋理 |
| --- | ---: | ---: |
| 89 × 128 比較樣本 | 22,095 B | 45,568 B（44.50 KiB） |
| 178 × 256 開發 PNG | 71,770 B | 182,272 B（178 KiB） |

下載為 PNG 回應 body 大小。紋理以 `width × height × 4` 估算，排除 ImageBitmap 的 CPU 副本、framebuffer 與驅動配置。同一畫布中的角色共用一份尺寸固定的紋理，雙開分屬兩個 WebGL context。和自然地形合用時，森林實驗 PNG 共 6,745,472 B（約 6.43 MiB），單份 RGBA8 合計約 27.88 MiB，含四張背景、自然地形 atlas 和新角色。開發圖集 SHA-256 為 `568865a8be19d6031ac891f3c281be0595c2dbc31d890edc5c6988e16f8f9488`。 [開發登錄](../../content/assets/experimental-character.json)

## 渲染與遊戲驗證

本機預測與校正、遠端插值和單機固定步進都沿用原本的 presentation frame。靜態貼圖以 body 的底邊中點繪製，預設高度 64，寬度 44.5 world units。來源朝右，左向以錨點為軸水平鏡射。七個狀態繼續由原有映射提供，實驗 renderer 一律取同一個圖框。切回舊版時用原有 clip；新圖載入失敗時也沿用原 Beginner 圖集及原向量回退。

「角色預覽」的碰撞框與腳底十字使用角色同一個 body 位置。測試透過真實鍵盤事件進圖與跳躍，在主地面 (y=896)、薄平台 (y=824) 和厚平台 (y=816) 驗證畫面腳底標記。多人驗證使用 Colyseus 測試伺服器、正常房間與原始地圖資料，第二個 Chromium 頁面以鍵盤移動，首個頁面在伺服器快照插值後的位置分別驗證兩個角色的髮色像素。

Slime 左向截圖使用 sprite 朝向覆寫。畫面下方 HUD 顯示遊戲中的角色朝向。

| 遊戲場景 | 截圖 |
| --- | --- |
| Village | [新角色](vf3/village.png) · [原版角色](vf3/village-legacy.png) |
| Forest Entrance | [桌面](vf3/forest-desktop.png) · [手機橫向](vf3/forest-mobile.png) · [手機控制](vf3/mobile-controls.png) |
| Slime 與朝向 | [右向](vf3/forest-slime-right.png) · [左向](vf3/forest-slime-left.png) |
| 主地面與平台 | [主地面碰撞框](vf3/forest-collision.png) · [薄平台](vf3/forest-thin.png) · [厚平台](vf3/forest-thick.png) |
| 多人同房 | [兩個瀏覽器](vf3/forest-multiplayer.png) |

## 硬體加速 FPS

Chromium 的 WebGL renderer 回報 Intel Iris Xe、ANGLE Direct3D11。待 Forest Entrance 與 64 world units 角色就緒後，以遊戲畫布在前景的 rAF 間隔取樣約五秒。桌面為正常多人房的兩個玩家與持續更新的怪物。手機為完成觸控進圖及跳躍後的單機遊戲。

| 視窗、畫布與 DPR | 樣本／秒數 | FPS | p50／p95 | 量測 |
| --- | --- | ---: | --- | --- |
| 桌面 1440 × 1000、畫布 1118 × 628、DPR 1 | 300／5.0001 | 60.00 | 16.7／16.9 ms | [JSON](vf3/desktop-d3d11.json) |
| 手機橫向 667 × 375、畫布 625 × 257、DPR 2 | 300／5.0002 | 60.00 | 16.7／17.0 ms | [JSON](vf3/mobile-d3d11.json) |

## 本機驗證

Windows 11 build 26200、Intel Core i7-1355U、Intel Iris Xe Graphics 驅動 32.0.101.7076、Node.js 24.18.0、pnpm 11.19.0、PixiJS 8.23.0、Vitest 5.1.1、Playwright 1.65.1、Chromium 159.0.8154.6。素材測量及生成用 Python 3.12.3 與 Pillow 10.3.0。pnpm 回報本機 Node 低於 workspace 的 24.22.3 下限。

- `pnpm exec vitest run apps/client/test/asset-rendering.test.mjs apps/client/test/asset-manifest.test.mjs apps/client/test/forest-terrain.test.mjs apps/client/test/parallax.test.mjs` 通過 46／46。覆蓋所有七個呈現狀態、五種預覽高度、本機與遠端朝向、未來得及完成的載入及圖集回退。 `pnpm run test` 通過 616／616（42 檔）。
- `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check`、`pnpm run check:boundaries`、`git diff --check` 通過。
- `pnpm run validate:assets` 驗證 26 個 sprite、5 張開發視差 PNG。重跑角色衍生指令，原圖、衍生 PNG 及 manifest 摘要與原次量測相同。 `pnpm run validate:maps` 通過七圖，`mapContentHash` 維持 `ee0a09e481b4d09daa529cf85a08cb7764685edf809f348a6c2dc62dbe94d5aa`。
- `pnpm run build` 通過。正式產物的 `game-assets/` 包含原有三張 PNG atlas 與署名。重新建置 client 的主 chunk 為 662.88 kB（gzip 197.23 kB），Vite 仍提示超過 500 kB。
- 開發版 Chromium 以 Direct3D11 通過 13／13（VF.3.1 共 4 項，既有視差與地形共 9 項）。三次 Village／Forest Entrance 往返共用單一 canvas，新圖只請求一次，活躍 ImageBitmap 與 WebGL 紋理各一份。離開森林釋放地形紋理，卸載遊戲後所有受追蹤的資產紋理歸零。另驗證未啟用時的請求數為零、HTTP 404 回退、手機觸控，以及兩個玩家共用同一畫布紋理。
- 正式建置的八項相關 Chromium smoke 均已取得通過結果。涵蓋冷載入（加上角色和視差 query，使用一般產物）、缺圖及解碼回退、手機觸控走訪及跳躍、DPR／resize、反覆卸載、12 向傳送與 150 ms RTT 雙瀏覽器傳送及重連。早期開發版執行曾遇到固定時鐘尚未推進圖集載入後的畫格、村莊圖集未就緒即比較回退截圖，以及平行建置觸發地形預覽熱重載。正式 smoke 的 150 ms 案例首次因傳送站位超出期望範圍失敗，獨立重跑通過。

```powershell
$env:VIESMA_PARALLAX_PORT = '4198'
$env:VIESMA_PARALLAX_HARDWARE = '1'
pnpm exec playwright test --config playwright.parallax.config.mjs --reporter=line

$env:VIESMA_SERVER_PORT = '25837'
pnpm exec playwright test tests/smoke/world.spec.mjs tests/smoke/assets.spec.mjs tests/smoke/input.spec.mjs tests/smoke/shell.spec.mjs tests/smoke/multiplayer.spec.mjs --grep 'keyboard visits all twelve|missing optional atlas|cold-load budget|touch to walk between Village|supports movement with jump|two-browser slice at 150 ms|resizes the same canvas|repeatedly mounts and disposes' --workers=1 --reporter=line

$env:VIESMA_SERVER_PORT = '25838'
pnpm exec playwright test tests/smoke/multiplayer.spec.mjs --grep 'two-browser slice at 150 ms' --workers=1 --reporter=line
```

## 視覺觀察與限制

64 world units 在桌面約為 56 CSS px 高。紅髮、貓耳、粉色裙與尾巴可用剪影辨識，鞋底落在三種表面上。角色在手機橫向遊戲畫布約 23 CSS px 高，眼鏡和臉部在縮圖與一般觀看距離較難讀。行走、跳躍、攻擊及受擊期間持續使用站姿。手機截圖和 FPS 為桌面 Chromium 的觸控／DPR 模擬，實機與長時間效能尚待驗證。

## 變更位置

- [角色 sprite view](../../apps/client/src/rendering/assets/sprite-views.ts) · [預覽選項](../../apps/client/src/rendering/character-preview.ts) · [共用世界 renderer](../../apps/client/src/rendering/world-renderer.ts)
- [遊戲預覽控制](../../apps/client/src/playground/character-preview-controls.tsx) · [遊戲外殼](../../apps/client/src/playground/playground.tsx) · [樣式](../../apps/client/src/playground/playground.css) · [單機接線](../../apps/client/src/playground/run-playground.ts) · [多人接線](../../apps/client/src/multiplayer/run-multiplayer.ts)
- [開發資產清單](../../content/assets/experimental-character.json) · [衍生 PNG](../../content/assets/images/beginner-static.png) · [生成器](../../content/assets/derive-beginner-character.py) · [來源](../../content/assets/provenance/beginner-character.md) · [資產管線](../../apps/client/tools/asset-project.ts) · [圖集驗證](../../apps/client/tools/asset-manifest.ts) · [視覺 ID](../../apps/client/src/rendering/assets/catalog.ts)
- [渲染與資產測試](../../apps/client/test/asset-rendering.test.mjs) · [開發 Chromium 驗證](../../tests/visual/character-preview.spec.mjs) · [正式資產 smoke](../../tests/smoke/assets.spec.mjs)
- [Visual Foundation](../VISUAL_FOUNDATION.md) · [架構](../ARCHITECTURE.md) · [資產規則](../ASSETS.md) · [Roadmap](../ROADMAP.md) · [驗證索引](README.md) · [VF.2.1b 驗收補記](VF2.1.md) · [畫面與量測](vf3/)

## VF.3.2a Base Body Integration

2026-11-27。下列保留原先 90 world units 的本機驗證紀錄。使用者已確認素體比例，現行預設為 80 world units。正式 roadmap 維持 29／46。 [驗收補記](#vf32a-驗收及-vf32b-契約) · [Visual Foundation](../VISUAL_FOUNDATION.md#vf3-逐幀-paper-doll)

### 原圖稽核

座標採左上含、右下不含。可見輪廓使用 `alpha ≥ 16`，與 VF.3.1 衍生流程一致。兩份原圖的 SHA-256 相同，原始位元組皆保留。原生朝左可從右側耳朵、頭形和鞋尖辨認。 [Base Body 原圖](../../art/source/characters/beginner/base-body/base-body-idle.png) · [來源與署名](../../content/assets/provenance/beginner-character.md)

| 項目 | 量測 |
| --- | --- |
| 原始 PNG | 1536 × 1024，畫布 3:2，8-bit RGBA，804,852 B |
| SHA-256 | `66d9c4ebeef10db49fd1495b23d5a091368f608d3e254a389ad0d3dc476f3bca` |
| 原圖 alpha | 範圍 0–254。1,418,294 像素全透明，154,570 像素半透明，其中 10,244 像素低於 16。全不透明像素 0 |
| 非零外框 | `(47, 0)–(1468, 982)`，1421 × 982 |
| 可見外框 | `(570, 204)–(943, 783)`，373 × 579，約 0.644:1 |
| 頭身比例 | 以原圖頭頸交界 `y ≈ 537` 目估，頭部高約 333 px，佔全高 57.5%，約 1.74 頭身 |
| 腳底中心 | `(740.5, 783)`。最低 3% 取 `[766, 783)`，該區可見輪廓的水平範圍為 `[644, 837)` |

### 遊戲比例與紋理成本

- Base Body 預設 90 world units，腳底置中裁圖後等比繪製，完整圖框約 63.28 × 90 units，可見輪廓寬約 58 units。碰撞盒高 48 units，素體為其 1.875 倍，頭部約 51.8 units。桌面畫布 1118 × 628 時，素體約高 79 CSS px。手機橫向畫布 625 × 257 時約高 32 CSS px，出生點的觸控按鈕會遮住部分腳底。
- 同一位置切為 64 units 時，圖框為 45 × 64 units，高度比 90 units 減少約 29%。Slime 的 32 × 32 像素圖框對應 32 × 32 world units，非零 alpha 區為 `(2, 14)–(30, 32)`，可見高 18 units。以可見高度比較，90／64 units 素體約為 Slime 的 5.00／3.56 倍。
- 衍生 PNG 為 180 × 256、45,405 B，SHA-256 是 `081e71fe24bd2f56ba68e6fe3813cafcd8d2d2bf7423cadf614e4f513d8c4715`。源圖視覺比例以一致的取樣倍率保留，圖框增加腳點置中所需的透明邊距。Character Master 衍生圖集的位元組與 VF.3.1 現行版一致。 [衍生 PNG](../../content/assets/images/beginner-base-body.png) · [開發登錄](../../content/assets/experimental-character.json)
- 每份 RGBA8 紋理估計 184,320 B（180 KiB），按 `180 × 256 × 4` 計算，排除 CPU ImageBitmap、framebuffer 與驅動配置。兩種模式都選過的畫布保留兩個獨立 atlas 合計 360 KiB。多人同一畫布只選 Base Body 時，本機與遠端使用同一個 ImageBitmap 及 WebGL 紋理。切圖重用，卸載時兩者歸零。

| 場景 | 截圖 |
| --- | --- |
| Village | [Base Body 90](vf3/base-body/village.png) · [Character Master 64](vf3/base-body/village-character-master.png) · [Legacy](vf3/base-body/village-legacy.png) |
| Forest Entrance | [桌面 90](vf3/base-body/forest-desktop.png) · [碰撞盒與腳底](vf3/base-body/forest-collision.png) |
| Slime | [90 朝右](vf3/base-body/forest-slime-right.png) · [90 朝左](vf3/base-body/forest-slime-left.png) · [64 朝右](vf3/base-body/forest-slime-64.png) |
| 手機橫向 | [90 與觸控按鈕](vf3/base-body/forest-mobile.png) · [調整為 80 與腳底標記](vf3/base-body/mobile-controls.png) |
| 多人 | [本機與插值後的遠端角色](vf3/base-body/forest-multiplayer.png) |

### 本機驗證

Windows 11 build 26200、Intel Core i7-1355U、Intel Iris Xe 驅動 32.0.101.7076。Node.js 24.18.0、pnpm 11.19.0、Vitest 5.1.1、PixiJS 8.23.0、Playwright 1.65.1、Chromium 159.0.8154.6。素材使用 Python 3.12.3 與 Pillow 10.3.0。pnpm 提示本機 Node 低於 workspace 的 24.22.3 下限。

- `pnpm exec vitest run apps/client/test/asset-rendering.test.mjs apps/client/test/asset-manifest.test.mjs apps/client/test/forest-terrain.test.mjs apps/client/test/parallax.test.mjs` 通過 48／48（4 檔）。驗證開發登錄、兩種素材的七種呈現狀態、六個高度、雙向鏡射、共用紋理以及回到 Legacy 的尺寸與朝向。
- `pnpm run test` 通過 630／630（42 檔）。`pnpm run format:check`、`git diff --check` 通過。另以 `git diff --no-index --check` 檢查本次修改的未追蹤文字檔。
- `python content/assets/derive-beginner-character.py` 重跑前後，兩份原圖、兩份衍生圖及登錄 SHA-256 一致。`pnpm run validate:assets` 驗證 27 個 sprite 及 5 張開發視差 PNG。`pnpm run typecheck`、`pnpm run lint`、`pnpm run check:boundaries` 通過，workspace 邊界涵蓋 8 個套件。
- `pnpm run build` 通過，`game-assets/` 產出原有三張正式圖集及署名。Vite 主 chunk 663.21 kB（gzip 197.39 kB），仍有 500 kB 警告。正式版資產 smoke 通過 2／2，驗證帶預覽 query 冷載入時維持既有圖集與署名，以及一般資產的 404 與解碼失敗回退。
- Cleanup 01 的 `test:visual` 入口以 Direct3D11 通過 13／13。角色套件驗證三種模式、Village／Forest Entrance 三次往返、兩張開發 PNG 各只請求一次、離開森林釋放地形資源、卸載釋放角色資源、兩張實驗 PNG 404 回退、手機觸控進圖與跳躍，以及同房本機／遠端共用紋理。腳底十字另在主地面、薄平台與厚平台驗證。一次角色套件重跑在手機 Village 的傳送門逾時。該案例改為縮短提示偵測間隔，並在提示出現後重新取得傳送按鈕座標，直接送出觸控事件，最終全套重跑通過。

沿用角色套件的 rAF 取樣，桌面為兩個同房玩家，手機為觸控走訪及跳躍後的單機模式。兩者約 60 FPS，p50／p95 為 16.7／16.9 ms。 [桌面 300 幀／5.0001 秒](vf3/base-body/desktop-d3d11.json) · [手機 300 幀／5.0000 秒](vf3/base-body/mobile-d3d11.json)

```powershell
$env:VIESMA_PARALLAX_PORT = '4399'
$env:VIESMA_PARALLAX_HARDWARE = '1'
pnpm run test:visual --output=node_modules/.cache/playwright-vf32a --reporter=line

$env:VIESMA_SERVER_PORT = '25847'
pnpm exec playwright test tests/smoke/assets.spec.mjs --workers=1 --reporter=line
```

手機畫面與量測來自桌面 Chromium 觸控模擬，實機待驗證。本階段的七種呈現狀態都共用 Idle 素體，逐幀動畫及圖層合成見後續階段。 [Paper Doll Animation Contract](../PAPER_DOLL_ANIMATION_CONTRACT.md)

## VF.3.2a 驗收及 VF.3.2b 契約

2026-11-27，使用者確認目前素體比例符合預期，鎖定約 1.74 頭身。Base Body 的開發預覽、資產登錄與生成器均改為預設高 80 world units，實際圖框寬為 56.25 world units（登錄取整為 56）。保留 48、56、64、72、80、90 高度選項、24 × 48 權威碰撞盒、腳底根基準、原生左向與右向鏡射。Character Master 預設仍為 64。 [Village 80 預設畫面](vf3/base-body/village-default-80.png)

Base Body 和 Character Master 原圖的 SHA-256 均為 `66d9c4ebeef10db49fd1495b23d5a091368f608d3e254a389ad0d3dc476f3bca`。原圖各自保存在原路徑。以暫存複本重跑 `python content/assets/derive-beginner-character.py`，兩張衍生 PNG 的摘要和新登錄位元組與工作區相符。另用 Pillow 以 `α ≥ 16` 重量原圖外框及鞋底，校對標示圖與範例的八點映射、圖集矩形、裁切偏移與透明外距。回填單格至 384 × 384 px 後，非零 alpha 外框為 (114, 64)–(282, 320)，腳底基準為 (192, 320)，從邏輯畫布裁回原圖框可逐像素還原。 [原圖掛載點標示](vf3/base-body/idle-attachments.png) · [JSON 範例](../paper-doll/beginner-idle-reference.json)

最終驗證使用 Windows 11 build 26200、Node.js 24.22.3、pnpm 11.19.0、Vitest 5.1.1、Playwright 1.65.1、Chromium 159.0.8154.6、Intel Iris Xe／ANGLE Direct3D11，以及 Python 3.12.3／Pillow 10.3.0。pnpm 入口與巢狀指令均使用符合 workspace engines 的 Node.js。先前預設 PATH 的 Node.js 24.18.0 僅作初次試跑，以下結果取符合版本的重跑。

| 驗證 | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/client/test/asset-rendering.test.mjs apps/client/test/asset-manifest.test.mjs apps/client/test/forest-terrain.test.mjs apps/client/test/parallax.test.mjs` | 48／48，四檔。包括高度登錄、圖框比例、腳點、兩向與同畫布紋理共享 |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check` | 通過。以空的 ignore 檔另對新契約及 JSON 執行 `prettier --check` |
| `pnpm run validate:assets` | 通過。27 個 sprite、5 張開發視差圖。契約 JSON 位於文件目錄，以獨立像素與座標稽核驗證 |
| `pnpm run test:visual --output=node_modules/.cache/playwright-vf32b --reporter=line` | 13／13。以 `VIESMA_PARALLAX_PORT=4408`、`VIESMA_PARALLAX_HARDWARE=1` 執行。涵蓋 80 預設與回切、朝向與著地、失敗回退、手機橫向觸控、同房本機與遠端，以及既有地形與視差 |
| `pnpm --filter @viesma/client run build` | 通過。正式資產仍為原有三張圖集及署名。主 chunk 663.21 kB，仍有既有 500 kB 警告 |
| `git diff --check` 與 `git diff --no-index --check` | 追蹤變更與本次涉及的未追蹤文字檔均通過 |

VF.3.2b 交付逐幀合成契約、素材製作規格與 VF.3.3 renderer 計畫，待使用者確認。真實多幀素材的連續性、外觀合成及手機實機仍待後續驗證。正式 roadmap 為 29／46。 [Paper Doll Animation Contract](../PAPER_DOLL_ANIMATION_CONTRACT.md) · [Visual Foundation](../VISUAL_FOUNDATION.md#vf3-逐幀-paper-doll)

## VF.3.3a Idle 素體稽核

2026-11-27。使用者已確認 VF.3.2b Animation Contract。VF.3.3a 在素材稽核判為 `BLOCKED`，正式 roadmap 維持 29／46。 [已確認的動畫契約](../PAPER_DOLL_ANIMATION_CONTRACT.md)

新原稿為 565,578 B。直接讀取 PNG IHDR 確認為 2172 × 724、8-bit RGBA（color type 6），從左到右為四格 543 × 724 px。SHA-256 為 `bd3aa929dd606c1ab5597e4689d6df14eea7c41f83909968b0cd5069d083f519`。原始靜態素體仍為 1536 × 1024，SHA-256 `66d9c4ebeef10db49fd1495b23d5a091368f608d3e254a389ad0d3dc476f3bca`。 [新原稿](../../art/source/characters/beginner/base-body/base-body-idle-sheet.png) · [原始靜態素體](../../art/source/characters/beginner/base-body/base-body-idle.png)

Alpha 直方圖全圖為 1,186,278 像素全透明、47,054 像素落於 α = 1–15、338,460 像素落於 α = 16–254、736 像素全不透明。以和原始靜態 PNG 相同的 α ≥ 16 規則量角色輪廓。低 alpha 像素中有 12,386 個落在各格可見框向外擴 3 px 的範圍之外，部分延伸至格邊。此散點在量測門檻下被排除。下列座標按每格左上為原點，外框右下排除。

| 格 | 非零 alpha 外框 | α ≥ 16 外框 | 腳底基線 | 鞋底帶中心 X | 遠／近側鞋底 X | 頭身估計 |
| --- | --- | --- | ---: | ---: | --- | ---: |
| 0 | (21, 19)–(543, 700) | (140, 142)–(421, 586) | 586 | 270.0 | 233.0／307.5 | 1.73 |
| 1 | (0, 31)–(543, 697) | (141, 132)–(421, 586) | 586 | 270.0 | 233.0／307.5 | 1.79 |
| 2 | (0, 21)–(543, 724) | (142, 125)–(420, 586) | 586 | 271.5 | 233.0／309.0 | 1.84 |
| 3 | (0, 26)–(523, 700) | (141, 139)–(423, 586) | 586 | 271.0 | 233.0／308.0 | 1.73 |

鞋底帶中心取可見框最後 13 列的 X 中點，個別鞋底取最低可見列兩段的 X 中點。與第 0 格相比，雙鞋中心水平漂移最多 1.5 原稿 px，依第 0 格倍率約 0.9 邏輯 px。頭身估計以頭頂至頸部最窄列為頭高，在各格頭頂下方 235–264 列內量外框寬。頭部輪廓另取從頭頂起 228 列的二值遮罩，以平移校準後與第 0 格比交並比。第 1–3 格分別為 99.1%、98.0%、99.2%。此量測顯示主要問題是固定腳底時的腿部拉長，而非頭部輪廓不一致。

第 0 格高 444 原稿 px，換算倍率為 256／444。四格可見高因此約為 256、261.8、265.8、257.7 邏輯 px。第 2 格頭頂比第 0 格上升 17 原稿 px，約 9.8 邏輯 px，超出契約峰值 2–4 px 的呼吸目標。胯部深色內側線的起始列 Y 為 494、482、478、494，量測取 x = 254–299 內連續三列，每列至少五個相鄰像素符合 α ≥ 64 且 RGB 各通道小於 105。腳底固定時，胯部到腳底的距離從 92 增為 108 原稿 px，峰值拉長約 17.4%，換算為 9.2 邏輯 px。以第 0 格倍率或平移對齊腳底，都會保留這個比例差。 [四格同尺度原稿與第 0／2 格疊圖](vf3/idle-sheet-audit.png)

使用 Windows 11、Python 3.12.3／Pillow 10.3.0，透過 `python -` 執行逐格 alpha 直方圖、二值輪廓、像素量測及圖像比對。此階段只追加稽核文件和原稿標示圖。衍生 PNG、metadata、預覽與程式驗證待修訂素材，尚未執行。解除條件為收到能維持腿部比例與雙腳接地、把吸氣峰值集中於胸肩並接近契約幅度的四格原稿，重跑同一份稽核後再做標準化。

## VF.3.3a Deterministic Idle Recovery

2026-11-27。VF.3.3a `LOCAL_VERIFIED`，等待使用者視覺驗收。正式 roadmap 維持 29／46。使用者改用已驗收靜態 Base Body 衍生四格 Idle。原四格稿、原靜態 PNG 與上節的原稿稽核留存。衍生器只有靜態 PNG 這一份動畫輸入，SHA-256 為 `66d9c4ebeef10db49fd1495b23d5a091368f608d3e254a389ad0d3dc476f3bca`。原四格稿 SHA-256 仍為 `bd3aa929dd606c1ab5597e4689d6df14eea7c41f83909968b0cd5069d083f519`。

### 素材衍生與驗收

沿用現行 Lanczos 等比重取樣與可見輪廓門檻，先把原圖 579 px 高的有效輪廓置入 384 × 384 px 畫布，縮放至 256 px、腳底點落在 (192, 320)。中性格由現有 180 × 256 px PNG 貼在 (102, 64)。後續各格只對工作畫布的像素做垂直映射。半像素位移若線性混色會改變描邊上的 RGBA 值，若取最近像素則仍需決定進位方向，因此採整數 0、−1、−3、−1 px，回落格重用與吸氣格同一幅度。

頭頸到胸肩的上部在 y ≤ 233 剛性平移。中央胸腹於 y = 233–264 之間平滑收回位移，兩側手臂與手掌跟隨肩膀，腕部與胸腹相接的狹帶平滑銜接。依列取最近原像素補齊間距，每欄垂直映射保留原取樣順序。固定區包括 y ≥ 274 的整列及骨盆核心 x = [173, 220)、y = [264, 274)。四格在該區的 RGBA 完全一致，腳底 X／Y 漂移為 0。頭部 y = [64, 212) 及兩側手掌的剛性區，反向對齊後 RGBA 完全一致。α ≥ 16 的遮罩各有一塊連通的角色輪廓及原有的臂下缺口，四格均未增加連通塊或透明孔。每格只取用中性格既有的 RGBA 值。

| 項目 | 實測 |
| --- | --- |
| 非零 alpha 外框 | 各格 X = [114, 282)，底邊 y = 320，頂邊依次為 64、63、61、63 |
| 可見高度／透明外距 | 256、257、259、257 px。四邊最小透明外距為 61 px |
| 圖集 | 1536 × 384 RGBA、65,881 B。SHA-256 `65b15865a21b13553401dbb1121f8bee628edbe887e7de9e512b9ab23d19aa4c` |
| 圖框 | 四格各 384 × 384，取樣矩形每側內縮 8 px，offset (8, 8)。取樣框加回透明外距後，與完整格逐像素相同 |
| 逐格掛載點 | 腳底 (192, 320)、近鞋底 (213.44, 320)、遠鞋底 (168.79, 320) 固定。頭、臉、軀幹、主手及副手的 Y 依實際映射各減去 0、1、3、1 px，X 與原生軸向維持相同 |
| 重建 | 在暫存根目錄執行同一命令，僅放入靜態原圖、既有 Character Master 和生成器。八項輸出與工作區逐位元相同，包括三張 PNG 圖集、登錄及四張稽核圖 |

```powershell
python content/assets/derive-beginner-character.py --evidence-dir docs/evidence/vf3/idle-derived
```

[四格同尺度圖](vf3/idle-derived/frames.png) · [頭部對齊疊圖](vf3/idle-derived/head-overlay.png) · [腿部像素差異圖](vf3/idle-derived/leg-diff.png) · [掛載點標示圖](vf3/idle-derived/attachments.png) · [PNG](../../content/assets/images/beginner-base-body-idle.png) · [metadata 登錄](../../content/assets/experimental-character.json)

### 開發預覽與資源

使用 `/?character=1`，於「角色素材」選 Animated Base Body。其四個 Texture 視圖在載入圖集時建立，共用同一個 ImageBitmap 與 WebGL 紋理。同畫布的各角色沿用各自的 Sprite 與呈現時鐘。每 6 ticks 切換幀，標準速度為 24 ticks／800 ms，轉向只改鏡射並保留腳點。非 Idle 使用靜態素體，資產錯誤依序回退 Legacy 與向量圖示。換圖重用角色圖集，卸載釋放角色視圖與共用資源。動畫圖集 RGBA8 估計佔 2.25 MiB，排除 CPU ImageBitmap、framebuffer 與驅動配置。

以 Chromium 159.0.8154.6、ANGLE Direct3D11／Intel Iris Xe 取樣約五秒的前景 `requestAnimationFrame`。桌面為同房本機與遠端兩位玩家，手機為單機輸入、轉場與跳躍後的橫向觸控模擬。

| 場景 | 視窗／畫布 CSS px／DPR | 樣本／時間 | FPS | p50／p95 |
| --- | --- | --- | ---: | --- |
| 桌面同房 | 1440 × 1000／1118 × 628／1 | 301／5.0166 s | 60.00 | 16.7／16.8 ms |
| 手機橫向模擬 | 667 × 375／625 × 257／2 | 300／5.0001 s | 60.00 | 16.7／16.8 ms |

此量測包含瀏覽器排程與遊戲畫布，手機實機和長時間效能待驗證。 [桌面取樣](vf3/idle-derived/desktop-d3d11.json) · [手機取樣](vf3/idle-derived/mobile-d3d11.json) · [開發環境控制項](vf3/idle-derived/preview-controls.png)

### 本機檢查

Windows 11 build 26200、Node.js 24.22.3、pnpm 11.19.0、Vitest 5.1.1、Playwright 1.65.1、PixiJS 8.23.0，素材建置使用 Python 3.12.3 與 Pillow 10.3.0。

| 指令 | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/client/test/asset-rendering.test.mjs apps/client/test/asset-manifest.test.mjs apps/client/test/forest-terrain.test.mjs apps/client/test/parallax.test.mjs` | 49／49，包含四幀預建、24 ticks／800 ms、暫停與變速、狀態回退、獨立相位、鏡射錨點與共用資源銷毀 |
| `pnpm run test` | 631／631，42 檔 |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check` | 通過，lint 內的 workspace 邊界檢查涵蓋 8 個套件 |
| `pnpm run validate:assets` | 通過，28 個 sprite、5 張開發視差圖 |
| `pnpm run build` | 通過。正式版只發行原有三張圖集和署名，檢查產物確認無動畫圖集及其預覽選項。主 chunk 664.45 kB，仍有既有的 500 kB 提示 |
| `pnpm exec playwright test --config playwright.parallax.config.mjs --output=node_modules/.cache/playwright-vf33a-verified --reporter=line` | 開發視覺套件 14／14，耗時 2.3 分鐘。使用 `VIESMA_PARALLAX_PORT=4417` 和 `VIESMA_PARALLAX_HARDWARE=1`。涵蓋循環與控制項、靜態回退、橫向觸控與轉場、同房紋理共享、卸載及既有視差和地形 |
| `pnpm exec playwright test tests/smoke/assets.spec.mjs --workers=1 --output=node_modules/.cache/playwright-vf33a-production --reporter=line` | 正式資產 smoke 2／2，使用 `VIESMA_SERVER_PORT=25849` |
| `git diff --check` 和未追蹤檔案的 `git diff --no-index --check` | 通過 |

開發中的視覺試跑曾受素材登錄熱重載、預覽控制疊在截圖上及起始 Idle 相位影響。最終整套在新開發伺服器上執行。循環截圖以已站穩的手選幀為參考，逐一比對由同一相位自動播放的畫面。精確 tick 邊界由聚焦測試覆蓋。

## VF.3.3b Paper Doll Layer Renderer

2026-11-27，VF.3.3b 為 `LOCAL_VERIFIED`。使用者已完成 VF.3.3a 呼吸動畫視覺驗收，預設改為 0.5x，80 world units。Metadata 維持四格各 6 ticks，30 Hz 下 1x 為 800 ms，0.5x 為 1600 ms，2x 為 400 ms。已驗收的 Idle PNG SHA-256 仍為 `65b15865a21b13553401dbb1121f8bee628edbe887e7de9e512b9ab23d19aa4c`。正式 roadmap 為 29／46。 [Visual Foundation](../VISUAL_FOUNDATION.md#vf33b-paper-doll-預覽)

### 遊戲內畫面

- 四張由遊戲畫布擷取的畫格使用相同範圍及 2x 最近鄰放大。藍色後髮標記被素體遮擋，洋紅前髮與綠色臉標記在第 0、1 格交疊處以洋紅為前，第 2 格以綠色為前。第 3 格省略前髮，其他兩個測試片與素體維持呈現。 [四幀對照](vf3/paper-doll/frames.png)
- 左右畫面採同一幀、同一位置與同一裁切範圍。三個診斷色的外框以腳底中心鏡射，左右誤差在 2 CSS px 內，垂直差在 1 CSS px 內。 [左右鏡射](vf3/paper-doll/mirror.png)
- Forest Entrance 桌面同房截圖包含兩個不同 Idle 幀的角色。橫向模擬以觸控操作走入 Forest Entrance。 [同房雙角色](vf3/paper-doll/forest-multiplayer.png) · [手機橫向](vf3/paper-doll/forest-mobile.png) · [預覽控制項與掛載點](vf3/paper-doll/controls.png)

### 渲染、資產與製作規格

- 共用 Beginner view 從角色自己的 `visualTick` 推進單一動畫狀態，記錄 ID、幀索引、播放速率、經過 ticks 與朝向。本機和遠端都以同一幀索引取素體 Texture 及掛載資料。靜態片的裁切原點對齊 head／face，並可跟隨掛載角度。姿勢專屬片使用同幀索引與畫布 offset。PixiJS Container 對整組套用同一個比例及腳底鏡射。相同順序時只更新圖框與位移，不重排 Sprite。
- 同一畫布在兩位玩家時，Idle atlas 與診斷 atlas 各一個請求及一份 bitmap／GPU source。Idle 預建四個 Texture view，診斷預建三個。移除遠端後，本機繼續使用相同資源。切圖沿用角色 scope，卸載後 atlas audit 的 bitmap／GPU source 均為空。Idle RGBA8 估計為 2.25 MiB，新增診斷圖 272 × 100，695 B 的 PNG 與約 106.25 KiB RGBA8。估計排除 ImageBitmap、framebuffer 與驅動額外配置。
- 正式前髮、後髮、臉以左向 8-bit RGBA 製作。使用 384 × 384 px 邏輯畫布、(192, 320) 腳底、0.3125 world unit／px，取 `beginner` poseVersion 1 同幀頭／臉座標及遮擋。頭部只需整片平移或旋轉時，交付一張透明圖和片內原點，髮片用 head、五官用 face。需要變形、拆片或姿勢專屬遮擋時，按 0–3 的順序交付同姿勢 1536 × 384 四格 sheet，附每片裁切 offset 和顯式空白幀。原稿保留 8 px 透明外距，atlas 圖框間留 2 px 擠邊及 2 px 間距。 [動畫與外觀契約](../PAPER_DOLL_ANIMATION_CONTRACT.md#外觀部件與遮擋) · [幾何診斷圖來源](../../content/assets/provenance/beginner-character.md)

### 短時效能

Windows 11 build 26200、Intel Iris Xe 驅動 32.0.101.7076、Chromium 159.0.8154.6、ANGLE Direct3D11、PixiJS 8.23.0。取 Forest Entrance 正常播放時約 5 秒的 requestAnimationFrame 間距。採樣含瀏覽器排程與場景渲染。

| 場景 | Viewport / canvas，CSS px | 間距樣本 | FPS | p50 / p95 |
| --- | --- | ---: | ---: | ---: |
| 桌面同房 2 人 | 1440 × 1000 / 1118 × 628，DPR 1 | 301 | 60.00 | 16.7 / 16.8 ms |
| 橫向觸控模擬 1 人 | 667 × 375 / 625 × 257，DPR 2 | 301 | 60.00 | 16.7 / 17.2 ms |

[桌面取樣](vf3/paper-doll/desktop-d3d11.json) · [橫向模擬取樣](vf3/paper-doll/mobile-d3d11.json)

### 本機驗證

使用 Node.js 24.22.3、pnpm 11.19.0、Vitest 5.1.1、Playwright 1.65.1。Playwright 以 Windows 11 上的 Chromium 159.0.8154.6 跑開發視覺及正式產物的資產 smoke。

| 指令 | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/client/test/asset-rendering.test.mjs apps/client/test/asset-manifest.test.mjs apps/client/test/forest-terrain.test.mjs apps/client/test/parallax.test.mjs` | 53／53。涵蓋 48 ticks 的預設循環、控制同步、幀序、裁切、掛載點、鏡射、缺片、素體回退及圖集釋放 |
| `pnpm test` | 635／635，42 檔 |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check` | 通過。Lint 亦執行 `check:boundaries`，檢查 8 個 workspace packages |
| `pnpm run validate:assets` | 通過，31 個 sprite、5 張開發視差圖 |
| `pnpm run build` | 通過。輸出 3 張正式圖集及署名，掃描產物也未出現 Idle atlas 或診斷 atlas／sprite ID。最大 chunk 665.18 kB，Vite 回報超過 500 kB 提示 |
| `pnpm exec playwright test --config playwright.parallax.config.mjs --output=node_modules/.cache/playwright-vf33b --reporter=line` | 15／15，2.4 分鐘。使用 `VIESMA_PARALLAX_HARDWARE=1`、`VIESMA_PARALLAX_PORT=4423`。涵蓋切圖、觸控、同房、卸載與既有視差地形 |
| `pnpm exec playwright test --config playwright.parallax.config.mjs tests/visual/character-preview.spec.mjs --grep 'Paper Doll captures' --output=node_modules/.cache/playwright-vf33b-pixels --reporter=line` | 1／1。硬體參數相同，埠 4424。追加以畫布交疊像素確認前片、臉標記的遮擋切換 |
| `pnpm exec playwright test tests/smoke/assets.spec.mjs --workers=1 --output=node_modules/.cache/playwright-vf33b-production --reporter=line` | 2／2。使用 `VIESMA_SERVER_PORT=25851`，驗證正式載入、署名與圖集錯誤回退 |
| `git diff --check` 與新增檔案的 `git diff --no-index --check` | 通過 |

### 變更檔案

| 範圍 | 檔案 |
| --- | --- |
| 圖層合成 | `apps/client/src/rendering/assets/paper-doll-view.ts`（新檔，132 行） |
| 既有角色與場景 | `apps/client/src/rendering/assets/sprite-views.ts`、`apps/client/src/rendering/assets/atlas-scope.ts`、`apps/client/src/rendering/assets/catalog.ts`、`apps/client/src/rendering/character-preview.ts`、`apps/client/src/rendering/world-renderer.ts` |
| 開發預覽 | `apps/client/src/playground/character-preview-controls.tsx`、`apps/client/src/playground/playground.css` |
| 開發資產 | `apps/client/tools/asset-manifest.ts`、`content/assets/experimental-character.json`、`content/assets/images/beginner-paper-doll-diagnostics.png`、`content/assets/provenance/beginner-character.md` |
| 驗證 | `apps/client/test/asset-rendering.test.mjs`、`apps/client/test/asset-manifest.test.mjs`、`tests/visual/character-preview.spec.mjs`、`tests/smoke/assets.spec.mjs` |
| 文件與證據 | `docs/VISUAL_FOUNDATION.md`、`docs/PAPER_DOLL_ANIMATION_CONTRACT.md`、`docs/evidence/VF3.md`、`docs/evidence/vf3/paper-doll/` |

### 剩餘驗收

VF.3.3b 等待使用者視覺驗收。此次遊戲畫面驗證涵蓋 Idle 的診斷片，逐幀外觀的共用索引與 offset 另以單元測試驗證。正式髮片、五官、其餘 slot 的實圖與其他動畫待有素材後驗收。手機使用 Chromium 橫向觸控模擬，實機與長時效能尚待驗證。

## VF.3.4a.1 Face Asset Integration

2026-11-27，VF.3.4a.1 為 `LOCAL_VERIFIED`。正式 roadmap 29／46。Face 01 已進入開發預覽，初始位置供使用者手動校正與視覺驗收。 [Visual Foundation](../VISUAL_FOUNDATION.md#vf34a1-face-01)

### 原稿稽核

Face 01 原稿 872,477 B。PNG IHDR 與 Pillow 均確認為 **1536 × 1024、8-bit RGBA**，SHA-256 `771c19f33dd188690b46bf78b810fc22ea75a7f3a65324477df2761f3b752dbe`。以下邊界以左上含、右下不含表示。 [原稿](../../art/source/characters/beginner/appearance/face/face-01/face-source.png) · [量測 JSON](vf3/face-01/source-audit.json) · [原始與清理比較](vf3/face-01/source-alpha.png)

| Alpha | 0 | 1–15 | 16–63 | 64–127 | 128–254 | 255 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 原像素數 | 1,464,840 | 17,030 | 1,965 | 1,376 | 87,653 | 0 |

- 全部非零 Alpha 外框為 (33, 87)–(1370, 1000)，由低 Alpha 散點拉大。Alpha ≥ 16 的外框為 (424, 354)–(1109, 768)，保留軟邊後的有效外框為 (422, 352)–(1111, 770)。清理以 Alpha ≥ 64 的筆畫為支撐，周圍 6 px 保留原值。支撐外移除 3,667 個非零像素，最高 Alpha 30。以深色底和 32x Alpha 檢查，眼白、眼睛高光、淺色鼻尖及腮紅均保留，筆畫之外未見連續光暈或膚色底圖。
- 以 Alpha ≥ 64 的眼部連通外框量測，畫面左側遠眼約 221 × 229 原稿 px，右側近眼約 302 × 227 px，寬度比例約 1.37。眼外框水平中心距約 422.5 原稿 px，內緣間距 161 px。等比後分別約 45.6 與 17.4 邏輯 px。近眼較寬，配合左向素體試貼時雙眼都落在臉部範圍，暫以原有比例和間距進行驗收。
- 原稿睫毛與眉毛保有明顯階梯式深紅描線，素體外緣是較連續的深色輪廓與半透明過渡。素體原稿到畫布的倍率約 0.442，Face 01 約 0.108。五官縮得更小，BOX 面積取樣保留細筆畫的部分像素覆蓋，遊戲尺寸下的高光較放大圖柔和。 [素體與合成近照](vf3/face-01/base-composite.png)

### 衍生、掛載與校正

```powershell
python content/assets/derive-beginner-character.py --face-only --evidence-dir docs/evidence/vf3/face-01
```

Python 3.12.3、Pillow 10.3.0。原稿以原生左向輸出。在 384 × 384 邏輯畫布使用 0.108 等比縮放，以原稿鼻尖附近 (692, 680) 對齊面部錨點，再整片向右 5、向上 3 邏輯 px 做初始試貼。裁切後外框 74 × 45、offset (128, 119)、片內原點 (23.99, 38.29)。82 × 53 的圖集含 2 px 擠邊與 2 px 外距，PNG 4,626 B，SHA-256 `59f3c68991b846af0f950924677c16e527da54f11db865efeb176d338361a333`。兩次重跑產生相同的圖集與登錄。Face 原稿、Base Body、Idle PNG、診斷圖集位元組保持相同。

Idle metadata 補登 v1 契約既有的標準遮擋順序，讓正式五官使用 `face` slot。四幀持續用原有 head、face、foot 座標與呼吸素材。初始校正 `{"xPx":0,"yPx":0,"scale":1}` 相對於上述試貼結果。偏移於整組鏡射前，以當幀 face anchor 和邏輯 px 加入，縮放以裁切原點為中心。四格試貼的五官像素均落在素體 Alpha ≥ 250 的範圍內。關閉 Face 01 時，畫布可逐像素回到同幀素體。 [開發資產登錄](../../content/assets/experimental-character.json) · [衍生 PNG](../../content/assets/images/beginner-face-01.png)

### 遊戲畫面與鏡射量測

- [80 world units 桌面與校正](vf3/face-01/desktop.png) · [實際畫布放大檢查](vf3/face-01/game-close-up.png) · [四幀合成](vf3/face-01/frames.png) · [左右鏡射](vf3/face-01/mirror.png)
- [橫向觸控模擬](vf3/face-01/mobile.png) · [Forest Entrance 同房雙角色](vf3/face-01/multiplayer.png)
- 邏輯驗證比對 PixiJS 變換後的點，左右 X 和等於兩倍腳底 X，Y 相同。帶入非零校正及等比縮放仍成立。第 2 幀的 face anchor 上移 3 邏輯 px，放到測試畫布的理想位移約 0.818 CSS px，像素外框量得 1 CSS px。
- VF.3.3b 的 2／1 CSS px 是截圖判定容差。這次同時記錄原幾何診斷圖與 Face 01 的像素殘差。畫布比例為 0.872222 CSS px／world unit，腳底投影落在分數 CSS px。截圖外框的像素索引為整數，取樣及 AA 門檻也會改變邊界像素是否計入。Face 01 左右外框在水平的兩個對稱和各比理想值少約 0.444 CSS px，原診斷片最大水平殘差約 0.556 CSS px，兩者 Y 差均為 0。邏輯座標的鏡射對稱仍成立。 [Face 01 像素量測](vf3/face-01/face-mirror-raster.json) · [原診斷片複測](vf3/face-01/diagnostic-mirror-raster.json)

四幀、鏡射與放大圖來自相同遊戲畫布裁切，以最近鄰放大。橫向使用 Chromium 模擬觸控。初始配對目前等待使用者校正與視覺驗收，手機實機仍待驗證。

### 回歸驗證

Windows 11 build 26200，Node.js 24.22.3、pnpm 11.19.0、Vitest 5.1.1、PixiJS 8.23.0、Playwright 1.65.1、Chromium 159.0.8154.6。開發視覺環境使用 Intel Iris Xe／ANGLE Direct3D11。校正測試涵蓋遊戲內抬升、顯示／隱藏、偏移、等比、重置、複製 JSON、手動選幀、0.5x 播放、暫停與 2x。單元測試確認校正沿用同一 Sprite／Texture，兩角色共用同一 Texture，移除本機視圖後遠端仍可存取。瀏覽器中同畫布各載一次 Idle 與 Face 01 atlas，移除遠端後請求計數相同，兩畫布分別卸載後 bitmap／GPU 紋理計數均為零。

| 指令 | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/client/test/asset-rendering.test.mjs apps/client/test/asset-manifest.test.mjs apps/client/test/forest-terrain.test.mjs apps/client/test/parallax.test.mjs` | 55／55 |
| `pnpm test` | 637／637，42 檔 |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check` | 通過。Lint 包含 `check:boundaries`，8 個 workspace packages |
| `pnpm run validate:assets` | 通過，32 個 sprite、5 張開發視差圖 |
| `pnpm run build` | 通過。產物只有 3 張正式圖集及署名。掃描確認監測的 Face 01 原稿、衍生 atlas、sprite ID 與既有診斷素材皆未發行。最大 chunk 665.25 kB，有 Vite 500 kB 提示 |
| `pnpm exec playwright test --config playwright.parallax.config.mjs tests/visual/character-preview.spec.mjs --grep 'Face 01 calibrates' --output=node_modules/.cache/playwright-vf341-first --reporter=line` | 1／1，使用 `VIESMA_PARALLAX_HARDWARE=1`、`VIESMA_PARALLAX_PORT=4429` |
| `pnpm exec playwright test --config playwright.parallax.config.mjs --output=node_modules/.cache/playwright-vf341 --reporter=line` | 16／16，2.6 分鐘。相同硬體參數，埠 4430。包含診斷片複測、Face 01 校正、桌面同房、橫向觸控切圖與既有地形／視差 |
| `pnpm exec playwright test tests/smoke/assets.spec.mjs --workers=1 --output=node_modules/.cache/playwright-vf341-production --reporter=line` | 2／2，使用 `VIESMA_SERVER_PORT=25853`。驗證正式請求、署名與 atlas 失敗回退 |
| `git diff --check` 與新增文字檔的 `git diff --no-index --check` | 通過 |

### 實際變更

以下行數以本次工作開始時的工作樹為基準，排除既有未提交變更。

| 範圍 | 檔案與行數 |
| --- | --- |
| 角色合成與預覽 | `apps/client/src/rendering/assets/catalog.ts`、`apps/client/src/rendering/assets/paper-doll-view.ts`、`apps/client/src/rendering/assets/sprite-views.ts`、`apps/client/src/rendering/world-renderer.ts`、`apps/client/src/rendering/character-preview.ts`、`apps/client/src/playground/character-preview-controls.tsx`、`apps/client/src/playground/playground.css`，合計 +171／−13 行 |
| 資產管線 | `apps/client/tools/asset-manifest.ts`（+47 行）、`content/assets/derive-beginner-character.py`（+157／−15 行）、`content/assets/experimental-character.json`（+112／−4 行）、`content/assets/images/beginner-face-01.png`、`content/assets/provenance/beginner-character.md` |
| 測試 | `apps/client/test/asset-rendering.test.mjs`、`apps/client/test/asset-manifest.test.mjs`、`tests/visual/character-preview.spec.mjs`、`tests/smoke/assets.spec.mjs`，合計 +236／−13 行 |
| 文件與證據 | `docs/VISUAL_FOUNDATION.md`、`docs/evidence/VF3.md`、`docs/evidence/vf3/face-01/` |

## VF.3.4a.1 Face 01 校正與外觀連續性

2026-11-27，follow-up 為 `LOCAL_VERIFIED`，等待再次視覺驗收。使用者提供本次預覽的暫定校正，正式 roadmap 仍為 29／46。 [目前預覽設定](../VISUAL_FOUNDATION.md#vf34a1-face-01)

### 修正前重現

- Playwright 以每 tick 呼叫一次畫布的固定時鐘輸入左右短按、持續左移、快速交替及放開。48 筆中有 31 筆 Run，左 22 筆、右 9 筆，Face 01 均消失。17 筆 Idle 全部可見。短按放開後，呈現狀態仍可繼續 Run，直到 simulation 回到 Idle。 [單機原始紀錄](vf3/face-01-continuity/before-local.json)
- 真實 Colyseus 開發測試房使用既有 server fixture 的 movement trace。權威資料在 Run 為 `action.kind=none`、`locomotion=run`。本機 prediction 投影與另一端的遠端插值呈現都為 Run、朝左、Face 01 不可見。兩端回到 Idle 時重新出現。 [多人原始紀錄與權威 tick](vf3/face-01-continuity/before-multiplayer.json)
- 根因是 Paper Doll 入口綁在 Idle atlas 的取幀成功條件。方向鍵令角色進入 Run，失去 Idle 紋理後改畫單張靜態素體，整組 Paper Doll 隱藏，這時沒有活動的合成圖層次序或掛載點。追蹤期間模式保持 `paper-doll`、臉片紋理可用，正式臉片也沒有啟用診斷空白幀。既有 frame 0 的掛載資料完整。

### 修正

素體 pose 選擇與外觀合成分開。Idle 繼續按原時鐘取四幀。Run、Jump、Fall、Attack、Hurt、Death 固定採中性素體和第 0 幀掛載資料。驗證 180 × 256 單格素體與 Idle 第 0 幀在邏輯畫布矩形 (102, 64)–(282, 320) 的 RGBA 位元組完全一致，兩個來源共用原有腳底基準。單格素體尚未可用時，可用已載入的同像素 Idle 第 0 幀作固定中性來源。兩份同時不可用仍走既有資產回退路徑。

合成保留同一組 Container、Sprite 與共享 Texture。轉向改父層鏡射，校正值仍在鏡射前套用。診斷模式的 Idle 空白幀、手動隱藏五官及 pose-specific frame 查找繼續按各自資料判斷。正式 Face 01 暫定預設值置於 `beginner-face-01` 的 `attachedFace.defaultCalibration`，由資產驗證解析並供預覽與 Reset 使用。暫存工作目錄重跑 `derive-beginner-character.py --face-only`，登錄與 Face PNG 位元組一致。 [資產設定](../../content/assets/experimental-character.json)

### 修正後狀態紀錄

| 樣本 | 修正前 | 修正後 |
| --- | --- | --- |
| 單機 17 筆 Idle | 17 筆 Face 可見 | 17 筆 Face 可見，使用當幀 Idle pose |
| 單機 31 筆 Run | 31 筆 Face 隱藏，單張素體 | 31 筆 Face 可見，中性 pose、幀索引 0 |
| 同房，本機 prediction 與遠端插值在 Run | 兩端 Face 隱藏，活動圖層次序及掛載點皆空 | 兩端 Face 可見，`baseBody → face`，face anchor (151.99, 157.29)，旋轉 0° |
| 放開方向鍵後回 Idle | 兩端恢復 Face | 兩端回到 Idle 的取樣均可見，恢復逐幀呼吸 |

追蹤各幀記錄 renderer mode、呈現狀態、朝向、活動 pose 與索引、臉片可見性、次序、紋理是否已載和實際掛載資料。多人權威 `tick` 同時記錄 action 及 locomotion。本機 prediction 投影的 `run` 表示 action 為 `none`，使用 locomotion。兩輪取樣的網路相位會影響 Idle 幀索引。 [單機修正後](vf3/face-01-continuity/after-local.json) · [多人修正後](vf3/face-01-continuity/after-multiplayer.json)

### 變更範圍與限制

- 渲染與證據入口位於 `apps/client/src/rendering/assets/sprite-views.ts`、`paper-doll-view.ts`、`apps/client/src/rendering/world-renderer.ts`。新增的 `appearanceDiagnostics=1` 只在開發預覽輸出實際合成狀態。
- 預設值與解析位於 `content/assets/experimental-character.json`、`content/assets/derive-beginner-character.py`、`apps/client/tools/asset-manifest.ts`、`apps/client/src/rendering/assets/catalog.ts`、`apps/client/src/rendering/character-preview.ts`、`apps/client/src/playground/character-preview-controls.tsx`。
- 測試涵蓋 `apps/client/test/asset-rendering.test.mjs`、`apps/client/test/asset-manifest.test.mjs`、`tests/visual/character-preview.spec.mjs`。新增約 47 行逐 tick 單機案例，延伸既有同房及校正案例。修正集中於既有 renderer 與資產管線。文件與原始紀錄位於 `docs/VISUAL_FOUNDATION.md`、本文件及 `docs/evidence/vf3/face-01-continuity/`。
- 非 Idle 仍使用中性素體，正式動作素材與手機實機驗收留待後續。暫定 Face 01 位置等待再次視覺驗收。

### 本機驗證

Windows 11、Node.js 24.22.3、pnpm 11.19.0、Vitest 5.1.1、Playwright 1.65.1、Chromium 159.0.8154.6，視覺測試使用 Intel Iris Xe／ANGLE Direct3D11。單元案例驗證六種中性狀態、可用的替代圖框、Sprite／Container／Texture 身分、雙向校正、回到 Idle 及手動隱藏。瀏覽器覆蓋實際執行中的狀態，並確認診斷空白幀、暫定值 Reset、0.5 px 調整、複製 JSON、共享請求和卸載。

| 指令 | 結果 |
| --- | --- |
| `pnpm exec playwright test --config playwright.parallax.config.mjs tests/visual/character-preview.spec.mjs --grep 'appearance continuity\|same room' --output=node_modules/.cache/playwright-face-before --reporter=line` | 修正前兩個案例均在 Run 的 Face 可見性斷言失敗。使用 `VIESMA_PARALLAX_HARDWARE=1`、`VIESMA_PARALLAX_PORT=4433` |
| `pnpm exec vitest run apps/client/test/asset-rendering.test.mjs apps/client/test/asset-manifest.test.mjs apps/client/test/forest-terrain.test.mjs apps/client/test/parallax.test.mjs` | 55／55 |
| `pnpm test` | 637／637，42 檔 |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check` | 通過。Lint 亦檢查 8 個 workspace packages 的依賴邊界 |
| `pnpm run validate:assets` | 通過，32 個 sprite、5 張開發視差圖。Base Body、Idle 和 Face PNG 雜湊與原紀錄相符 |
| `pnpm run build` | 通過。產物掃描確認只發行既有三張正式圖集及署名。保留 Vite 大於 500 kB 的 chunk 提示 |
| `pnpm exec playwright test --config playwright.parallax.config.mjs --output=node_modules/.cache/playwright-face-after --reporter=line` | 17／17，3.0 分鐘。相同硬體參數，埠 4434 |
| `pnpm exec playwright test tests/smoke/assets.spec.mjs --workers=1 --output=node_modules/.cache/playwright-face-production --reporter=line` | 2／2，使用 `VIESMA_SERVER_PORT=25855` |
| `git diff --check` 與新增文字檔的 `git diff --no-index --check` | 通過 |

## VF.1 至 VF.3.4a.1 提交前複驗

2026-11-27 於 Windows 11 build 26200、Node.js 24.22.3、pnpm 11.19.0 複驗。

- `pnpm run test` 通過 42 檔、637／637。Typecheck、lint（含 8 個 workspace package 的依賴邊界）、格式、`pnpm run validate:assets` 和 `pnpm run build` 通過。Vite 仍提示 665.45 kB 的主 chunk 超過 500 kB。
- `pnpm exec playwright test --config playwright.parallax.config.mjs --reporter=line` 使用 Playwright 1.65.1、Chromium 159.0.8154.6、ANGLE Direct3D11、埠 4451，通過 17／17。橫向操作使用瀏覽器觸控模擬。
- `pnpm exec playwright test tests/smoke/assets.spec.mjs --workers=1 --reporter=line` 使用正式建置與 server 埠 25857，通過 2／2。
- Paper Doll 診斷圖層、Face 01 校正的視覺確認、手機實機與遠端 CI 仍待補齊。
