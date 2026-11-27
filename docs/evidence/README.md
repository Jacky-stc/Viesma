# 驗證證據索引

[開發路線圖](../ROADMAP.md) 定義任務、依賴、驗收與狀態。此處收錄各 milestone 的實作與驗證紀錄。

| 檔案                             | 內容                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| [M0](M0.md)                      | Workspace、domain、CI／開發服務、game-data                        |
| [M1](M1.md)                      | Physics、角色、Pixi、桌面／觸控及重生                             |
| [M2](M2.md)                      | Tiled、七圖、素材、NPC 及走訪                                     |
| [M3](M3.md)                      | Room、預測、插值、跨房／重連與網路初測                            |
| [M4](M4.md)                      | 共享戰鬥、death claim、10 分鐘耐久與延後驗證                      |
| [M5](M5.md)                      | 成長、個人掉落、背包與裝備，含本機及遠端驗收                      |
| [PostgreSQL 契約 spike](PG-CONTRACT-SPIKE.md) | 背包換位、角色鎖、原子收據、COMMIT 恢復與非同步 tick              |
| [Early Capacity Spike](EARLY-CAPACITY-SPIKE.md) | M5.5 單程序 Colyseus 容量、席位、戰鬥／交易與保留量               |
| [CI 穩定化](CI-STABILIZATION.md) | Smoke 失敗調查、回歸修正與已查證的 GitHub Actions 結果            |
| [VF.1](VF1.md) | Forest Entrance 素材稽核、視差預覽、畫面與資源釋放 |
| [VF.2](VF2.md) | Forest Entrance 地形切片、前景限制、碰撞比對與畫面驗證 |
| [VF.2.1b](VF2.1.md) | Forest Entrance 原圖與內接點稽核、三模式截圖、權威地圖比對及硬體加速量測 |
| [VF.3.1](VF3.md) | Beginner 靜態原圖與腳點稽核、遊戲畫面、多人與資源釋放、硬體加速量測 |
| [VF.3.2a](VF3.md#vf32a-base-body-integration) | Base Body 頭身、朝向、碰撞與 Slime 比例、三種預覽模式、手機與多人畫面 |
| [VF.3.2b](VF3.md#vf32a-驗收及-vf32b-契約) | 使用者素體驗收、80 units 預設驗證、Idle 掛載點及動畫契約 |
| [VF.3.3a](VF3.md#vf33a-deterministic-idle-recovery) | 原稿稽核、靜態素體衍生、Idle 預覽、資源與效能取樣 |
| [VF.3.3b](VF3.md#vf33b-paper-doll-layer-renderer) | Idle 視覺驗收、Paper Doll 掛載與遮擋、鏡射及資源共用 |
| [VF.3.4a.1](VF3.md#vf34a1-face-01-校正與外觀連續性) | Face 01 校正、非 Idle 狀態的外觀連續性與多人複驗 |

每次驗證記錄日期、環境與版本、指令或操作、結果與樣本數、量測條件、已知限制及未驗證項目。有遠端紀錄時連結實作 SHA 和對應 workflow run。保留歷史原值與當時結論，追加後續結果時標明適用提交與檢查範圍。當前的工具鏈 pins 見 [README 版本矩陣](../../README.md#版本矩陣)。
