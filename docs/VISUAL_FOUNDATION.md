# Visual Foundation

## VF.0 方向

Forest Entrance 採原創暖橘手繪奇幻森林。由逆光天空、霧中的廢墟、遠林、近林及較深的前景形成層次，讓角色、平台邊線及出入口在樹影中仍易辨識。六張交件以原始 PNG 保存在 `art/source/environments/forest-entrance/`。L4 是地形／裝飾圖塊來源。 [素材來源](../content/assets/provenance/forest-entrance.md) · [實際素材稽核](evidence/VF1.md)

## VF.1 實驗場景

由本機工作區執行 `pnpm --filter @viesma/client run dev --port 4175 --strictPort`，開啟 `http://127.0.0.1:4175/parallax.html`。預覽以 Forest Entrance 的地形、入口出生點與既有 Beginner 角色顯示遊玩比例。桌面與手機橫向預設分別為 1280 × 720 和 667 × 375 CSS 像素，視窗較窄時等比縮小。相機 X/Y 是視窗左上角的世界座標，縮放倍率乘上既有相機的視窗比例。可用負座標檢查地圖外緣。自動移動沿 X 軸在入口至東側往返，JSON 匯出包含 `mapId` 與各層當前設定。

遊戲測試場使用 `http://127.0.0.1:4175/?parallax=1`，由 Village 進 Forest Entrance 即可檢視實驗圖層。預覽與實驗圖片由 Vite 開發伺服器提供。正式建置保持灰盒背景和走訪流程。

檢查接縫時，可勾選單層的「水平重複」並調整 X 位移，將接合處移進畫面。預覽表單只在操作時更新 React state，畫布由共用 renderer 更新，FPS 讀數每約 500 ms 更新。

| 層／`assetId`          | 平面／順序 | 對齊             | `factorX`／`factorY` | `scale` | `offsetX`／`offsetY` | `opacity` | `repeatX` |
| ---------------------- | ---------- | ---------------- | -------------------- | ------- | -------------------- | --------- | --------- |
| L0 `forest-sky`        | 背景／0    | `viewport-cover` | 0／0                 | 1       | 0／0                 | 1         | 否        |
| L1 `forest-ruins`      | 背景／10   | `map-bottom`     | 0.1／1               | 1       | −380／−195           | 1         | 是        |
| L2 `forest-far-trees`  | 背景／20   | `map-bottom`     | 0.3／1               | 1       | −300／−115           | 1         | 是        |
| L3 `forest-near-trees` | 背景／30   | `map-bottom`     | 0.6／1               | 1       | −160／−25            | 1         | 是        |
| L5 `forest-foreground` | 前景／50   | `map-bottom`     | 1.1／1               | 0.72    | −220／100            | 0.64      | 是        |

預設全部可見。`map-bottom` 以地圖範圍底緣對齊原始圖像畫布，位移以 world units 為單位。`viewport-cover` 等比放大並約束偏移量，天空會隨視窗比例裁到可視區域。這些值可在 [Forest Entrance 預設](../apps/client/src/rendering/forest-parallax.ts) 調整。整體渲染順序為視差背景、地形、視差前景、角色／怪物／掉落／傷害數字，HUD 仍為 React DOM。

## VF.2 地形與前景

預覽的「VF.2 矩形」保留 VF.2 的 L4 地形與 L5 前景。開發遊戲可用 `?parallax=rectangular` 開啟相同模式。「碰撞邊界」疊上現行碰撞矩形。相機可接續檢查西岸、中央裂隙及東側高台。 [VF.2 證據](evidence/VF2.md)

L4 使用九個 32 × 32 像素圖塊、每格對應 32 world units。左／右端貼齊碰撞矩形，中段與較薄平台裁到矩形的實際寬高。L5 對齊方式改為 `ground-band`，Y 位移調整為 80 world units，X 因子仍為 1.1。以兩段主地板的內部區帶限制前景繪製，首格草面和兩岸間的裂隙保持可讀。上節表格保留 VF.1 的驗收基線。 [Tiled 製作流程](TILED_MAPS.md) · [素材切片](../content/assets/forest-terrain-slices.json)

## VF.2.1b 自然地形

VF.2.1b 已於 2026-11-27 取得使用者視覺驗收，本機技術驗證狀態為 `LOCAL_VERIFIED`。`/parallax.html` 預設顯示自然地形，同一個鏡頭可以切換灰盒、VF.2 矩形和 VF.2.1 自然地形。開發遊戲以 `/?parallax=1` 進入 Forest Entrance 時使用同一個渲染模式，正式建置與一般進入流程沿用灰盒。

九個不等寬部件分別對應主地板、實體踏台和單向平台。渲染器對齊既有碰撞上緣，以完整端蓋加上重複中段涵蓋各段寬度。草葉、土層和根系共用地形的世界相機，L0–L3 沿用 VF.2 設定。自然地形模式的前景由 L4 內嵌植被提供，獨立 L5 及區帶留在 VF.2 比較模式。 [素材與接點](../apps/client/src/rendering/forest-organic-terrain-slices.json) · [VF.2.1b 驗證](evidence/VF2.1.md)

長地板的重複與內接點、薄平台的草葉與藤蔓輪廓、世界底緣的露底、L1／L2 背景接縫，以及森林在實機上的可讀性延後處理。 [VF.2.1b 驗證與延後項目](evidence/VF2.1.md) · [VF.1 接縫稽核](evidence/VF1.md#原始素材稽核)

## VF.3 逐幀 Paper Doll

Beginner 採逐幀繪製的完整素體。髮型、服裝與配件以同姿勢的逐幀圖層疊在素體上，共用幀序與腳底基準。Base Body 先以實際 Idle 單格確認頭身、腳點、左右方向、碰撞盒與怪物的畫面比例。 [VF.3 驗證](evidence/VF3.md)

| 子階段 | 範圍 | 狀態 |
| --- | --- | --- |
| VF.3.1 Character Master | 靜態開發圖集與 Legacy 比較，預設高 64 world units | `LOCAL_VERIFIED`，保留比較模式 |
| VF.3.2a Base Body | 驗收約 1.74 頭身的 Idle 素體，鎖定預設高度 80 world units | `LOCAL_VERIFIED`，使用者已確認素體比例 |
| VF.3.2b Animation Contract | 固定畫布、掛載點、逐幀合成契約及 Idle 素材製作規格 | `LOCAL_VERIFIED`，使用者已確認契約 |
| VF.3.3a Idle Base Body Animation | 從已驗收靜態素體衍生呼吸動畫並接入開發預覽 | `LOCAL_VERIFIED`，使用者已完成視覺驗收並結案 |
| VF.3.3b Paper Doll Layer Renderer | 以幾何測試圖驗證後髮、素體、臉、前髮的同步取幀、遮擋與鏡射 | `LOCAL_VERIFIED`，等待使用者視覺驗收 |
| VF.3.4a.1 Face Asset Integration | 接入 Face 01 美術、校正工具及中性 pose 的外觀連續性 | `LOCAL_VERIFIED`，等待再次視覺驗收 |

### VF.3.2a Base Body 預覽

2026-11-27，使用者已確認素體約 1.74 頭身符合預期。開發遊戲以 `/?parallax=1&character=1` 預覽自然地形與 Beginner。僅加 `?character=1` 可在灰盒場景比較。畫布右上角的「角色預覽」可切換 Base Body、Character Master 或 Legacy。前兩者可選 48、56、64、72、80、90 world units，切換時分別回到預設值 80 或 64。Legacy 使用原有動畫和尺寸。可開啟 24 × 48 角色碰撞框與腳底十字，並讓本機角色跟隨操作或固定朝向。

Base Body 與目前的 Character Master 都原生朝左，朝右時繞腳底中心水平鏡射。兩者各只有一張 Idle 圖框，所有角色呈現狀態暫時共用。等比縮放後，腳底中心對齊既有角色 body 的底邊中點。「多人測試」的本機與遠端角色共用 sprite view 與圖集，遠端依插值後的狀態呈現朝向。開發圖集載入失敗時依序使用既有 Beginner 圖集與向量圖示。 [資產重建](ASSETS.md#vf3-開發用角色素材) · [VF.3.2a 稽核與畫面](evidence/VF3.md#vf32a-base-body-integration)

Base Body 與 Character Master 的現行原圖 SHA-256 同為 `66d9c4ebeef10db49fd1495b23d5a091368f608d3e254a389ad0d3dc476f3bca`，兩份原圖各自保留在現有來源路徑。 [使用者驗收與 80 units 驗證](evidence/VF3.md#vf32a-驗收及-vf32b-契約)

### VF.3.2b 動畫契約

Beginner 各狀態共用 384 × 384 px 邏輯畫布、(192, 320) 腳底基準及 0.3125 world unit／px。素體提供唯一幀序與時長，外觀依相同姿勢和幀索引對位。每幀提供掛載點及自己的遮擋順序，裁切圖以 offset 還原至同一作畫座標後，整組繞腳底基準鏡射。首批製作規格為原生朝左的四格 Idle。 [動畫契約與 VF.3.3 計畫](PAPER_DOLL_ANIMATION_CONTRACT.md) · [實圖掛載點](evidence/vf3/base-body/idle-attachments.png) · [JSON 範例](paper-doll/beginner-idle-reference.json)

### VF.3.3a Idle 素體稽核

原四格稿的第 2 格胯部到腳底比第 0 格長約 17%，頭頂升幅等比換算後約 9.8 px，因此當時停在原稿稽核。Recovery 依使用者方向改由已驗收的靜態素體衍生，四格頭、肩與掌心上移量為 0、1、3、1 px。胸腹以原像素過渡至固定骨盆，保留腿腳、腳底基準及原生朝向。兩份原稿與原稽核均保留。 [原稿量測](evidence/VF3.md#vf33a-idle-素體稽核) · [衍生量測與結果](evidence/VF3.md#vf33a-deterministic-idle-recovery)

### VF.3.3a 動畫預覽

用開發模式的 `/?character=1` 開啟「角色預覽」，在「角色素材」選 Animated Base Body。Static Base Body 仍為預設比較模式，Character Master 和 Legacy 也可切換。Animated Base Body 預設 80 world units。Metadata 四格各 6 ticks，30 Hz 的基準週期為 800 ms。使用者完成呼吸動畫視覺驗收後，預設播放速率設為 0.5x，實際週期為 1600 ms。預覽可暫停、手選第 0–3 格、選 0.5x／1x／2x、顯示掛載點，並可調整尺寸、朝向及顯示腳底十字與 24 × 48 碰撞框。

本機與遠端共用 atlas，各角色進入 Idle 時建立自己的播放相位。其他呈現狀態使用靜態素體，載入失敗依序回退到既有 Legacy atlas 和向量圖示。 [衍生與資產規則](ASSETS.md#vf3-開發用角色素材)

### VF.3.3b Paper Doll 預覽

在同一個「角色素材」選單切換 Paper Doll。藍色折線佔用後髮 slot，綠色十字佔用臉 slot，洋紅折線佔用前髮 slot。手選第 2 格可看到臉與前髮交換前後關係，第 3 格展示缺少前髮。可關閉整組測試外觀、開啟掛載點，或顯示本機角色當幀實際可見的圖層順序。紙娃娃模式沿用相同的 80 world units、0.5x 預設和播放控制。

各角色沿用同一個 Idle 時鐘，先決定幀索引，再取同幀素體、掛載點和遮擋順序。靜態片用裁切圖內原點對齊當幀的頭／臉掛載點，姿勢專屬片可用同幀索引及畫布 offset。整組在 PixiJS Container 共用比例與腳底鏡射。同一畫布的本機和遠端角色各有自己的 Sprite 組和播放相位，共用 atlas 紋理。 [素材製作契約](PAPER_DOLL_ANIMATION_CONTRACT.md#外觀部件與遮擋) · [VF.3.3b 驗證](evidence/VF3.md#vf33b-paper-doll-layer-renderer)

### VF.3.4a.1 Face 01

開發模式使用 `/?character=1`，在「角色預覽」選 Paper Doll。Face 01 預設可見，掛在正式 pose 的 `face` slot，素體高度 80 world units，Idle 預設 0.5x／1600 ms。「Face 01 校正」使用資產的暫定預設值 `{"xPx":5.5,"yPx":27.5,"scale":1.3}`，重置回到同一組值。偏移相對於當幀 face anchor，以 384 × 384 邏輯畫布 px 表示，每次調整 0.5 px，於角色鏡射前套用。可隱藏 Face 01 或複製 JSON，手動設定保留於當次預覽。

勾選「測試外觀圖層」可切回 VF.3.3b 幾何診斷。 [原稿稽核與畫面](evidence/VF3.md#vf34a1-face-asset-integration)

Run、Jump、Fall、Attack、Hurt、Death 暫用中性靜態素體。Paper Doll 使用中性的掛載點與正式遮擋順序持續合成外觀，回到 Idle 再由四幀呼吸動畫取幀。暫定校正與外觀連續性等候再次視覺驗收。 [重現與修正前後紀錄](evidence/VF3.md#vf34a1-face-01-校正與外觀連續性)
