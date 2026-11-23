# ADR-001 — 選用 PixiJS v8，而非 Phaser

- 狀態：Accepted，Task 0 架構基線。
- 日期：2026-11-23。
- 適用範圍：client world rendering、animation、camera 與 asset presentation。

## 背景

產品需要可在 browser 與 Node.js 共用的 pure TypeScript simulation、custom platformer physics、server-authoritative combat，以及 React DOM UI。若 gameplay 綁定完整 client engine 的 scene／physics lifecycle，後續 server 重用與 prediction 容易產生兩套規則。首個 MVP 只有七圖、單職業與三種 monster，範圍可用小型 renderer adapter 管理。

## 決策

以 **PixiJS v8** 畫 2D world，以 React 處理 account／HUD／inventory／party／AP／NPC panels。Physics、simulation、combat 不依賴 Pixi；render adapter 接收 plain view models。Tiled 匯出經 validation 轉為 normalized map data，不讓 renderer loader 決定 collision。

Pixi render loop 與30Hz simulation 分開。Client 可以依 display refresh rate 插值；server 不建立 canvas、不 import Pixi。WebGL 是 mobile baseline，WebGPU 非必要。實際 asset atlas、culling、camera 與 animation 是明確的小型模組，不建立通用 engine framework。

## 考慮過的方案

- **Phaser**：內建 scenes、input、physics 與 tilemap 工具能加速單機原型；本案仍需將 authority／physics 拆出去，額外 engine lifecycle 增加整合成本。若將來證明 Pixi 工具成本過高，可用實測資料重評。
- **Canvas 2D 自製 renderer**：依賴少，但 atlas batching、animation 與 mobile render 維護成本較高。
- **PixiJS**：保留 renderer 邊界與 React 配合，代價是自行負責 camera、map presentation、animation 與 resources lifecycle。

## 影響

優點是相同 simulation 可做 server／headless tests／local prediction，client rendering 可獨立調整。成本是 M1.3／M2.4 要實作及驗證 render tooling，尤其 resize、texture release、DPR 與 mobile frame cost。

## 驗證與重評

M1.3 驗證 lifecycle／camera／resize；M3.5 驗證 adapter 不干涉 authority；M8.2／M8.3 驗證20 players＋12 monsters的 render budget。若實際維護或效能問題有證據，新增 superseding ADR；目前不更換指定 stack。

相關文件：[ARCHITECTURE §2／§10](../ARCHITECTURE.md)、[ROADMAP](../ROADMAP.md)。官方參考：[PixiJS v8 Render Loop](https://pixijs.com/8.x/guides/concepts/render-loop)。
