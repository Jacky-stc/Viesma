# Viesma 視覺資產

M2.4 提供三張小型原創圖集，涵蓋 Beginner 七種狀態、Slime／Mushroom／Bat、Village 圖塊與 Guide，以及一個掉落袋。Village 的地形、平台與傳送區仍由 graybox 幾何繪製。M2.5 將登錄的 `village-guide` sprite 錨定在 Tiled 的 `npc_guide` 點，並由 simulation 管理互動距離。怪物與掉落袋仍是供檢視圖集的靜態樣本。

## 目錄與格式

| 位置 | 內容 |
| --- | --- |
| [content/assets/manifest.json](../content/assets/manifest.json) | 版本化圖集、視覺 ID、圖框、圖像尺寸及授權登錄。 |
| [content/assets/images/](../content/assets/images/) | 版控內的來源 PNG。V1 支援最大 2048 × 2048 像素、8-bit RGB／RGBA、非交錯的靜態 PNG。動畫以 JSON 指定圖框。 |
| [content/assets/provenance/](../content/assets/provenance/) | 可審查的創作來源、授權或署名證據。 |
| `apps/client/dist/game-assets/` | Vite 發行的圖集與 `attribution.txt`。 |

`schemaVersion` 目前為 1。每個 `atlases[]` 有 `id`、`type: "atlas"`、`source`、`output`、`sha256`、`width`、`height`、`rights` 和 `sprites`。路徑相對於資產目錄，使用小寫 ASCII 與正斜線，禁止父目錄引用及 symlink。宣告的輸出是 `game-assets/<atlas-id>.png`，建置在副檔名前加入來源 SHA-256 的前 16 碼，完整摘要用於驗證。

`sprites[]` 的 ID 在整份 manifest 唯一，使用小寫 kebab-case。類型為 `player`、`monster`、`tile`、`npc` 或 `loot`。每個 sprite 繼承所在圖集的來源及權利欄位。`renderWidth`、`renderHeight` 以 world units 表示，圖框的 `x`、`y`、`width`、`height` 以原圖像素表示。`clips` 以狀態名稱索引，每筆含依播放順序排列的 `frames`、正整數 `ticksPerFrame` 及 `loop`。非循環動畫停在末幀。Beginner 必須覆蓋 `idle`、`run`、`jump`、`fall`、`attack`、`hurt`、`death`。

## 授權與來源紀錄

- **專案原創**使用 `kind: "original"` 與 `license: "project-owned"`。填寫 `creator`，並在 `evidence` 指向 repo 內的創作來源和權利紀錄。若有已公開的原始頁面，填寫 `source`。
- **第三方授權**使用 `kind: "licensed"`。目前政策只接受 CC0 1.0 與 CC BY 4.0，須有作者、原素材的 HTTPS 頁面、保留的授權證據及 `changes`。未修改的素材也應填寫「未修改」。公開可下載的圖片仍須取得合適授權。無法證明來源、授權不明或不在白名單的素材不得進入建置。 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **署名**。CC BY 4.0 須提供 `attribution`，保留作者或指定署名人、原始版權／授權／免責聲明等適用資訊，並以 `changes` 記錄裁切、改色或其他變更。每份 build 都附 `game-assets/attribution.txt`，使用者可從「操作說明」開啟。
- **生成素材**須記錄創作者、生成方法或工具版本、可重建的本機來源或已記錄的設定、輸入素材來源及權利依據。若有 repo 內的生成程式，可填 `generator`。生成過程使用第三方來源時，依實際權利及署名條件登錄；同一張圖集使用一致的權利紀錄。 [本次圖集來源](../content/assets/provenance/graybox.md)
- **引用限制**。本專案使用原創視覺。不得匯入 MapleStory 的角色、場景、UI、音效或其他受保護素材。授權檢查可證明檔案與登錄相符、證據存在及欄位完整，權利人及授權適用性由貢獻者提供證據並由維護者審查。

## 新增或更新素材

1. 決定授權分類並保留原頁面、許可或創作紀錄。第三方證據須能辨認作品、作者、適用條款與取得日期。將每張同一權利來源的 PNG 放入 `images/`。
2. 在 manifest 登錄來源、SHA-256、尺寸、圖框和署名。維持原已發布 ID 的語意。重新產出現有原創樣本可執行 `node content/assets/draw-graybox.mjs`，刻意改圖時同步更新摘要與圖框。Build 直接使用版控 PNG，因此可離線重建。
3. 在 client rendering 以穩定 ID 引用新素材。Tiled 外部 tileset 如果使用圖集，將同一份已登錄的 tile atlas PNG 放在 Tiled 可解析的相對路徑，確認大小與位元組一致。 [Tiled 地圖製作指南](TILED_MAPS.md)
4. 執行 `pnpm run validate:assets`、`pnpm run validate:maps`、`pnpm run test`、`pnpm run build` 和 `pnpm run test:smoke`。Vite 自動驗證來源、授權、PNG、引用及輸出，只發行登錄圖集與署名。不要以 `public/`、直接 import、data URL 或外部 URL 繞過登錄。

## 載入與限制

Vite 產生用於 lazy loading 的 client manifest。Beginner 在場景期間共用一份圖集，地圖圖集在該圖需要顯示相應素材時才載入。換圖會銷毀前一張地圖的 sprite、frame texture、GPU source 與 ImageBitmap，並取消尚未完成的 fetch。卸載會一併釋放 Beginner。圖片載入在 render 端獨立進行，腳底從 24 × 48 的碰撞盒計算，動畫由渲染 tick 選幀。

開發時可省略標了 `optionalInDevelopment` 的 PNG。缺圖、下載失敗或解碼錯誤時，Beginner 沿用原有幾何圖示，缺少的裝飾和 NPC sprite 略過，同一圖集於該場景只嘗試一次。Guide 距離判定、提示和對話仍由遊戲資料提供。修改 manifest、來源或登錄狀態後重新啟動 dev server。正式建置要求所有已登錄檔案都存在。

目前使用固定圖框，支援循環和停在末幀。完整 Tiled tile layer 繪製、量產美術、自動打包、音訊與實機效能測試留待對應任務。七張現行地圖尚未引用外部 atlas tileset。資產圖片位元組及 sprite clip 留在 client manifest。Tiled 路徑及格線等既有正規化欄位仍依契約納入地圖 hash。

## VF.1 開發用視差素材

五張 Forest Entrance 全圖 PNG 由獨立的 [實驗登錄](../content/assets/experimental-parallax.json) 引用 `art/source/environments/forest-entrance/` 的原始檔。開發登錄允許最大 4096 × 4096 的全圖 PNG 並沿用 M2.4 的 PNG、SHA-256、授權、雜湊 URL 及署名驗證。一般圖集維持 2048 × 2048 的上限。`pnpm run validate:assets` 檢查兩份登錄，Vite 正式建置只發行一般圖集。開發伺服器可略過缺失的實驗 PNG，遊戲回退至可用圖層或灰盒。 [來源](../content/assets/provenance/forest-entrance.md) · [稽核](evidence/VF1.md)

VF.2 的 108 × 108 地形圖集屬開發登錄，沿用 M2.4 的圖框、署名和 SHA-256 驗證。圖框為 32 × 32 像素，周圍各 2 px 以邊緣像素外擴。`pnpm run validate:assets` 也檢查此登錄。以 Python 3.12／Pillow 10.3.0 執行 `python content/assets/slice-forest-terrain.py` 可重建圖集、tileset 檔及接觸表。產出後以 `pnpm exec prettier --write content/assets/experimental-terrain.json` 格式化圖集登錄。 [圖集登錄](../content/assets/experimental-terrain.json) · [切片清單](../content/assets/forest-terrain-slices.json)

VF.2.1b 以同一管線登錄九個可獨立取樣的非方形圖框。執行 `python content/assets/slice-forest-organic-terrain.py` 重建衍生 atlas 與其登錄。生成器先核對四張來源的 SHA-256，輸出後由 `pnpm run validate:assets` 驗證 atlas 的尺寸與摘要。 [圖集登錄](../content/assets/experimental-organic-terrain.json) · [切片清單](../apps/client/src/rendering/forest-organic-terrain-slices.json)

## VF.3 開發用角色素材

`python content/assets/derive-beginner-character.py` 從 `character-master.png` 與 `base-body/base-body-idle.png` 生成兩張高 256 px 的單格圖集及共同登錄。生成器先核對 Base Body 原圖 SHA-256，再印出兩張原圖的摘要、可見輪廓及腳底錨點。預設錨點取可見輪廓最低 3% 區段的水平中點。`--foot-x` 可微調 Character Master 的原圖 X 座標。以 `pnpm run validate:assets` 驗證衍生圖與署名。更新 Base Body 原圖時，先重做像素與朝向稽核，再登錄新的摘要。

開發伺服器會於角色登錄更新後重新載入資產。開發遊戲使用 `?character=1`，按選取的模式載入對應的雜湊 URL。兩個靜態圖集各有一個 `idle` 圖框，所有角色狀態共用該圖框，實際 world width 由圖框比例決定。換圖時同步核對各模式的 `sourceFacing`。使用相同畫布的本機與遠端角色共用已載入的紋理。 [原圖來源](../content/assets/provenance/beginner-character.md) · [開發登錄](../content/assets/experimental-character.json) · [預覽設定](../apps/client/src/rendering/character-preview.ts)

同一指令也從已驗收的靜態 Base Body 生成 Animated Base Body。加上 `--evidence-dir docs/evidence/vf3/idle-derived` 可一併重建同尺度對照、頭部疊圖、腿部差異與掛載點標示。1536 × 384 PNG 由四格 384 × 384 組成，atlas 取樣框每側向內 8 px，metadata 用 (8, 8) offset 還原同一腳底基準。實際逐格 metadata 在開發登錄中的 `beginner-base-body-idle` sprite 下的 `idlePose`。正式建置沿用既有資產登錄。 [衍生驗證](evidence/VF3.md#vf33a-deterministic-idle-recovery) · [runtime PNG](../content/assets/images/beginner-base-body-idle.png)
