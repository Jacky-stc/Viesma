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
| [CI 穩定化](CI-STABILIZATION.md) | Smoke 失敗調查、回歸修正與已查證的 GitHub Actions 結果            |

每次驗證記錄日期、環境與版本、指令或操作、結果與樣本數、量測條件、已知限制及未驗證項目。有遠端紀錄時連結實作 SHA 和對應 workflow run。保留歷史原值與當時結論，追加後續結果時標明適用提交與檢查範圍。當前的工具鏈 pins 見 [README 版本矩陣](../../README.md#版本矩陣)。
