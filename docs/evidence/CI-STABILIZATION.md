# CI 穩定化與遠端驗證

[證據索引](README.md) · [開發路線圖](../ROADMAP.md)

## 已查證的遠端 CI

2026-11-25 查閱 GitHub Actions 的 `CI` workflow，當時本機 HEAD 與最新 `main` push run 均指向 M5.1 實作提交 `48a4fef8e4f8365c0604d7a8b2f707a4539da480`。歷史各節的「待執行」或 Docker 引擎未回應描述當時環境。最新 `verify` 的 Ubuntu smoke 與 PostgreSQL health smoke 均通過，資料庫 repository transactions 依 ROADMAP 另驗。 [M5.1 驗收](M5.md#m51)

| 提交      | 結果                                        | 遠端紀錄                                                                        |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `48a4fef` | 成功，M5.1 實作提交                         | [Run 45638521960](https://github.com/Jacky-stc/Viesma/actions/runs/45638521960) |
| `23762f2` | 成功，150 ms RTT smoke 穩定化               | [Run 45629833638](https://github.com/Jacky-stc/Viesma/actions/runs/45629833638) |
| `2adc3dc` | 失敗，後續跳躍迴歸調查的依據                | [Run 45616966742](https://github.com/Jacky-stc/Viesma/actions/runs/45616966742) |
| `e118342` | 失敗                                        | [Run 45613133240](https://github.com/Jacky-stc/Viesma/actions/runs/45613133240) |
| `3f2c052` | 失敗，後續 `23762f2` 已驗證其後的整合程式碼 | [Run 45611110733](https://github.com/Jacky-stc/Viesma/actions/runs/45611110733) |
| `2f737ae` | 成功，M4 本機紀錄引用的舊基線               | [Run 45460525502](https://github.com/Jacky-stc/Viesma/actions/runs/45460525502) |

## M1.4 觸控取消與旋轉

[M1.4 驗證證據](M1.md#m14)

- **CI 迴歸（2026-11-25）**。觸控 smoke 在直橫向切換後等待原生動畫幀，讓瀏覽器先送出清除舊輸入的媒體查詢事件，再推進測試中的固定步進或開始新的觸控。Windows 對 Chromium 159.0.8154.6 執行完整 smoke，21 項均通過。GitHub Actions 的 Ubuntu 驗證待執行。
- **觸控取消迴歸（2026-11-25）**。固定步進前先確認向右與跳躍的兩個 `pointercancel` 均已送達。受控延遲重現 HUD 停留於跑步，取消送達後再推進遊戲便回到待機。150 ms RTT 多人 smoke 也在鍵盤與觸控跳躍輸入前開始記錄本機 HUD 與遠端高度。Ubuntu 24.04／Chromium 159.0.8154.6 完整 smoke 共 21 項通過，第二批使用兩個 worker。旋轉與雙指取消案例另重跑 20 次，均通過。GitHub Actions 待驗證。

## Pre-M3.4 維護

[M3.3 驗證證據](M3.md#m33)

**Pre-M3.4 維護（2026-11-25）**。六幀佇列保留有效輸入邊緣，加入 200 ms 伺服器排隊期限與累積 ACK 回歸。多人地圖名稱取自已載入資料，畫面診斷改為明確啟用，根 dev 入口集中建置共享套件，CI 由 lint 執行套件邊界檢查。Node.js 24.22.3／pnpm 11.19.0 通過 356 項 Vitest，三個 dev 入口皆從乾淨輸出啟動。 [輸入與同步契約](../ARCHITECTURE.md#5-input-protocol-與同步) · [開發與驗證](../../README.md#開發環境)

六 worker 重疊測試重現 `WORLD_TICK_BACKLOG`。拒絕前喚醒間隔達 3.36 秒，Node 主執行緒約用 16 ms CPU，入房時仍積欠 92 ticks，支持測試主機資源競爭是主因。`test:smoke` 先用單 worker 跑多人測試，完成清理後再以預設 worker 跑其餘測試。保留入房保護、30 Hz 步進、5 ticks 補跑上限、10 Hz 公開 patch、輸入佇列與 TTL、ACK 與校正契約。需要調查全套平行負載時，直接執行 `pnpm exec playwright test --workers=6`。 [Smoke 指令](../../README.md#app-smoke)

Windows 以 Node.js 24.22.3／pnpm 11.19.0 通過資產與地圖驗證、typecheck、lint、格式與套件邊界檢查、356 項 Vitest 及正式建置。`--list` 確認兩批完整涵蓋原有 17 項且無重複。兩輪 smoke 都通過多人 3/3 與其餘 14/14。已驗證兩批的退出碼、啟動失敗與 Windows Ctrl+C 清理。Ubuntu CI 待執行。多人 smoke 的量測範圍為單房雙瀏覽器，多房、滿房與長時間負載仍由 M8.3 驗證。

## M3.5 150 ms RTT 跳躍與傳送

[M3.5 驗證證據](M3.md#m35)

- **150 ms RTT 跳躍迴歸（2026-11-25）**。`2adc3dc` 的 Ubuntu CI 在行動預測起跳後看到遠端 Y 仍為 848。本機 Ubuntu 26.04.1 重現時，Slime 在 tick 466 扣 7 HP，伺服器在 tick 470 套用已入列的 `seq 328` 時角色仍為 Hurt。該幀消耗輸入，權威位置及持續繪圖的旁觀端 Y 均維持 848。Windows 重現於受傷 tick 493、套用 tick 494 的 `seq 311`。前次觀測器只記錄畫面，未能判定跳躍是否在伺服器執行。同步測試夾具將入口 Slime 的巡邏移出經過驗證的測試走廊。決定性回歸重播同一輸入，原地圖在 Hurt 期間不起跳，隔離夾具正常起跳，兩場的十隻怪物 ID 與 HP 一致。CI 失敗時會保留 `mobile-jump-trace`。本機可用 `VIESMA_CAPTURE_JUMP_TRACE=1` 保留成功案例的 trace。 [CI 失敗紀錄](https://github.com/Jacky-stc/Viesma/actions/runs/45616966742/job/139214745315) · [決定性回歸](../../apps/server/test/world-travel.test.mjs)
- **迴歸驗證**。使用 Node.js 24.22.3／pnpm 11.19.0／Chromium 159.0.8154.6。Windows 專項重跑 4／4。Ubuntu 26.04.1 專項重跑的跳躍斷言 6／6，整個案例 3／6，其餘三次失敗發生於後續傳送位置或測試總時限。兩個環境各執行一次完整 smoke，均通過多人 7／7 和其他 14／14。Ubuntu 另通過 typecheck、lint、格式、448 項 Vitest、建置、地圖與資產驗證。Compose 設定通過，Docker 引擎未回應，PostgreSQL health smoke 待驗證。修正版的 GitHub Actions 待執行。
- **傳送 smoke 穩定化（2026-11-25）**。Ubuntu 基線 trace 顯示，原測試在 client 預測 X 為 242.00 時放鍵，權威 X 仍為 293.33。另一案於 28.20 秒完成回 M1 的權威提交，但在逐項檢查畫面時耗盡 30 秒。測試改以權威位置放鍵，並行驗證獨立的設定與畫面條件。第一輪驗收 9／10，唯一失敗發生在 Village 站穩後立即讀取預測 X。權威 X 為 1036.67，預測 X 一度為 1022.01，約 69 ms 後的 checkpoint 將預測校正回 1036.67。測試因此等待同房、同 epoch 的停穩 checkpoint 才驗證原座標範圍，且以房間、角色和地圖 epoch 驗證目的地 checkpoint。第二輪在 Ubuntu 26.04.1 以同一 Chromium 版本、一個 worker、零 retries 連續通過 10／10 個完整案例，耗時 21.77–27.62 秒。沿用 30 秒案例上限。 [多人 smoke](../../tests/smoke/multiplayer.spec.mjs) · [Transfer 診斷](../../tests/smoke/mobile-jump-trace.mjs)
- **穩定化驗證**。Ubuntu 與 Windows 的完整 smoke 均通過 21／21（多人 7／7、其餘 14／14）。Ubuntu 通過 typecheck、lint、套件邊界、格式、448 項 Vitest、建置、地圖與資產驗證。Compose 設定通過，Docker 引擎未回應，PostgreSQL health smoke 待驗證。修正版的 GitHub Actions 待執行。
- **診斷欄位複驗**。checkpoint trace 明確選取房間、地圖與 epoch 欄位，避免保存傳送票券。相同版本與設定下，Ubuntu 再次連續通過 10／10 個完整案例。最慢案例在第 29.36 秒進入最後的畫面與量測檢查，Playwright 判定通過，接近原有時限。
