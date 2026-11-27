# Beginner 角色原圖來源

VF.3.1 的原圖由 Viesma 專案擁有者提供，供專案角色外觀預覽。專案內登錄為 `project-owned`，署名 `Viesma · Beginner`。個人作者署名、生成工具與版本、設定、輸入素材及公開來源未隨交件提供。使用工作區原圖與 SHA-256 識別本次交件。

- 目前交件為 1536 × 1024、8-bit RGBA 的角色底模，SHA-256 為 `66d9c4ebeef10db49fd1495b23d5a091368f608d3e254a389ad0d3dc476f3bca`。 [現行原圖](../../../art/source/characters/beginner/character-master.png)
- VF.3.2a 由專案擁有者指定的 Base Body Idle 原圖與現行 Character Master 具有相同的 SHA-256，登錄同一權利與署名，保留獨立來源路徑與衍生 atlas。 [Base Body 原圖](../../../art/source/characters/beginner/base-body/base-body-idle.png) · [本次稽核](../../../docs/evidence/VF3.md#vf32a-base-body-integration)
- 初次 VF.3.1 驗證使用 1312 × 1199、8-bit RGBA 的彩色角色，當時的 SHA-256 為 `de2f0d8c4cbff59c592d5f597c879a800116f0c430f3374298e41e044303e6d5`。 [初次驗證](../../../docs/evidence/VF3.md)
- 開發版單格 PNG 由 Python／Pillow 依可見 alpha 裁切，以雙腳落點置中並等比縮小。開發資產署名隨登錄輸出。 [重建指令碼](../derive-beginner-character.py) · [開發登錄](../experimental-character.json) · [像素稽核](../../../docs/evidence/VF3.md)
- VF.3.3a 動畫沿用專案自有的靜態 Base Body，四格由同一生成器取原像素衍生，沿用 `Viesma · Beginner` 署名。原四格稿保留為歷史稽核，SHA-256 為 `bd3aa929dd606c1ab5597e4689d6df14eea7c41f83909968b0cd5069d083f519`。 [原稿稽核](../../../docs/evidence/VF3.md#vf33a-idle-素體稽核) · [確定性衍生](../../../docs/evidence/VF3.md#vf33a-deterministic-idle-recovery)

## VF.3.3b 開發診斷圖集

`images/beginner-paper-doll-diagnostics.png` 是 Viesma 原創幾何測試圖，採 project-owned 授權，署名 Viesma · Beginner Paper Doll development diagnostics。以 Pillow 繪製藍色折線、綠色十字和洋紅折線，分別佔用後髮、臉和前髮 slot。三片都沿用同一張開發專用圖集，圖框外保留擠邊及間距。這些標記供檢查掛載與遮擋。

## VF.3.4a.1 Face 01

五官原稿由 Viesma 專案擁有者提供，沿用角色素材的 `project-owned` 登錄，署名 `Viesma · Beginner Face 01`。1536 × 1024、8-bit RGBA 原稿的 SHA-256 為 `771c19f33dd188690b46bf78b810fc22ea75a7f3a65324477df2761f3b752dbe`。衍生器保留五官筆畫周圍的原始 Alpha，再以等比縮小和裁切產生開發專用圖集。 [五官原稿](../../../art/source/characters/beginner/appearance/face/face-01/face-source.png) · [衍生器](../derive-beginner-character.py) · [稽核](../../../docs/evidence/VF3.md#vf34a1-face-asset-integration)
