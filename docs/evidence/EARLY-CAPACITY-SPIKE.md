# Early Capacity Spike

2026-11-26 · [路線圖](../ROADMAP.md#容量-spikem55-後) · [M5.5 驗收](M5.md#m55) · [證據索引](README.md)

**基線建議為 `FIX_CRITICAL_CORRECTNESS`。** 20 人／1 個 M1 房與 60 人／3 個 M1 房各通過 600 秒。140 人／7 個 M1 房的重跑在 435 秒因目的房持有預留席位時被銷毀而中止。同一 race 可用兩個真實 Colyseus client 重現。基線最高完整驗證負載為 60 人、3 個 M1 房與按需建立的 Village。

**修正後 Stage C 為 `VERIFIED`。** 同一主機與負載完成 140 人／7 個 M1 房、600.056 秒。182／182 次交接、140／140 次受控重連，活票的 522 為 0。 [修正後量測](#修正後-stage-c--140-人7-戰鬥房)

## 基線與環境

- 實作 SHA 為 `eb05fcf923fb78b4c354363c09ed26eac6806db5`。本機 HEAD、遠端 `main` 與 GitHub Actions `head_sha` 一致，`CI / verify` 成功。M5.5 核定 `DONE`，正式進度 29／46（63.04%）。 [實作](https://github.com/Jacky-stc/Viesma/commit/eb05fcf923fb78b4c354363c09ed26eac6806db5) · [CI run](https://github.com/Jacky-stc/Viesma/actions/runs/45699725623) · [Verify job](https://github.com/Jacky-stc/Viesma/actions/runs/45699725623/job/139506334167)
- 原 checkout 起始有兩筆使用者改動，將 Slime base HP 60 改為 10、角色初始 HP 50 改為 5000。量測在 `git archive HEAD` 匯出的乾淨 runtime 進行，另放入 spike harness 與測試。正式資料為 `mvp-1`、protocol 7、map manifest SHA-256 `ee0a09e481b4d09daa529cf85a08cb7764685edf809f348a6c2dc62dbe94d5aa`。
- Windows 11 Home build 26200，Intel Core i7-1355U，12 logical CPUs，16,786,800,640 bytes RAM（15.63 GiB）。Node.js 24.22.3、pnpm 11.19.0，以 frozen lockfile 安裝。Server 為 `pnpm run build` 產出的 `apps/server/dist`，Colyseus core 0.18.29、ws transport 0.18.5、SDK 0.18.10。一個 server process 與一個 SDK load process 共用同台主機，各自記錄 CPU、RSS 與 V8 heap。傳輸走 `127.0.0.1` 隨機埠、WebSocket、4 KiB max payload、100 ms patch 與預設心跳。

## Workload 與重現

每個正式樣本先等待所有角色收到自己的權威 `MapRoomJoined`，核對 20 個唯一角色／戰鬥房、世界 seat／body 與第 21 席的探測結果，接著 warmup 15 秒，再以單調時鐘量測至少 600 秒，每 5 秒寫一筆 JSONL。階段從新的 server 與 load process 開始。目標為 A 20 人／1 M1、B 60 人／3 M1、C 140 人／7 M1。每個 M1 依正式地圖載入 6 Slime（每隻 71 HP、40 BaseEXP）及 4 Mushroom（每隻 139 HP、120 BaseEXP），Village 無怪。核對累計樣本時，轉場或死亡返村可建立暫時的 Village；同一角色在交接時可跨兩房占席，唯一角色數仍只計一次。

每房 12 個 combat actor、4 個移動／跳躍 actor、4 個站立並持續送中立輸入的 actor。輸入目標 30 Hz。戰鬥 actor 依最近一次 schema 和角色 checkpoint 尋找入口平地的兩個 Slime，對齊方向和距離後以 520–663 ms 的間隔嘗試普攻，仍受正式 18-tick cooldown、windup、判定與 AI 約束。移動組在 x 320–410 往返，約每 2.4–2.6 秒嘗試一次地面跳躍。攻擊組接近本人掉落時最多每 300 ms 嘗試一次 pickup，低 HP 時可使用背包 HP 藥水。每 7 筆成功命令約重送一筆原 payload，確認同一收據回應；怪物生命、EXP、地面掉落和物品均透過正式交易。每房配置一個 portal actor，warmup 尾端起錯開 3 秒，之後約每 45 秒嘗試往返 Village。站立組每房錯開 2 秒，之後每 30 秒輪換一人，以 ws close 模擬中斷，等 300 ms 再用正式 reconnect token 入房。怪物 RNG 沿用每房 seed `1`，匿名 ID 與正式 HMAC 掉落 RNG 由 spike seed `20261126` 派生。排程由真時鐘及 socket 驅動，程序間時序會影響多角色的傷害排序與 roll。

在含 spike 檔案的 checkout，以固定工具鏈執行下列指令。若 checkout 有 gameplay 改動，先將基線匯出至獨立目錄，再複製本次的六個測試檔。階段的最後一筆 `cleanup` 結果含 drain 後 verdict，通過才進下一階段。

```powershell
$spikeDir = Join-Path ([IO.Path]::GetTempPath()) ('viesma-capacity-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $spikeDir | Out-Null
git archive --format=tar --output="$spikeDir/baseline.tar" eb05fcf923fb78b4c354363c09ed26eac6806db5
tar -xf "$spikeDir/baseline.tar" -C $spikeDir
Copy-Item -Path 'apps/server/test/*capacity*.mjs' -Destination "$spikeDir/apps/server/test"
Set-Location $spikeDir
pnpm install --frozen-lockfile
pnpm run build
node apps/server/test/run-early-capacity.mjs --stage A --output stage-a.jsonl
# A 以 VERIFIED 結案後啟動 B。B 以 VERIFIED 結案後啟動 C。
node apps/server/test/run-early-capacity.mjs --stage B --output stage-b.jsonl
node apps/server/test/run-early-capacity.mjs --stage C --output stage-c.jsonl
```

## 量測口徑

- 測試入口重用正式 WorldCoordinator、MapRuntime、Colyseus MapRoom、reward worker、CharacterCoordinator、兩個 memory repository。test-only import hook 在已編譯的固定 tick callback 及 simulation step 外觀察，沒有 fork simulation 或改動 tick budget。World tick 的 wall duration 包含 reward completion、ground expiry、route、mutation 與所有房間步進。每個房間另計 `advance` 與 `onBeforePatch`，後者不含後續 schema encode。Drift 是固定 tick 到期至其 scheduler wake 的延遲。額外 catch-up ticks、醒來單次最高步數及積欠獨立計數。
- Event-loop delay 用 Node monitor，resolution 10 ms，Windows 計時器粒度會反映在結果。CPU 百分比用 CPU time／wall time，100% 為一個邏輯核心。RSS、heap used／heap total 取自各程序每 5 秒的樣本。V8 GC 計 observer 可見的事件與 duration。
- 頻寬是實際 WS binary application payload，含 schema、checkpoint、combat 和私人訊息。排除 HTTP matchmaker、WS framing、ping/pong、TCP 及 TLS。送出後立即取 ws `bufferedAmount` 峰值，無法分辨 OS socket buffer 與遠端壅塞，短暫 cork 記在峰值。以 loopback 及單一 load process 測得的結果只適用同機競爭條件。
- Seat 依正式 runtime transition 追蹤，按樣本核對唯一 authoritative bodies；轉場與重連後以原 socket 驗證舊 route 無輸入及私人回覆。輸入 queue 取既有 movement trace，記 per-character 最大深度、逐房估計聚合峰值及清退原因。Mutation queue 代理值從 pickup／consume 接收至最後一個 owner result，包含同步拒絕和 receipt 命中，與路由內部的 `commands.length` 有差異。
- Reward latency 從 lethal claim 到實際 memory commit。另計已完成的死亡（RewardPending → dead）、respawn、retry 和 receipt release。Pending peak 計 claim 至 commit，commit 到下個 tick 套用的時間另由 completed death 與 drain 對帳。Reward 和 mutation 的 latency／peak 含 warmup，期間內吞吐扣除 warmup。收據 bytes 是 JSON UTF-8 payload 估算，未含 Map、物件或 GC 空間。Ground active／terminal 從已提交 grant、真實 pickup 和 expiry wall clock 對帳。觀察程式本身執行 trace callback、計時、座位／交易核對並留存 ID 和 grant／receipt 參照，包含在所報的 CPU／heap，沒有逐項扣除 overhead。

## 階段結果

### Stage A · 20 人／1 戰鬥房

| 項目 | 觀察 |
| --- | --- |
| verdict 與樣本 | `VERIFIED`，600.085 秒，119 筆間隔樣本，18,002 ticks |
| 房間與席位 | M1 入房及結束均 20 個唯一角色，最高 20 active／1 reserved，active + reserved 最高 20。14 次臨時 Village，各最高 1 席。第 21 席遭 matchmaker 拒絕（522，room locked） |
| World tick p50／p95／p99／max | 0.364／0.857／1.527／4.735 ms |
| 到期至 wake p50／p95／p99／max | 18.203／35.586／39.977／52.658 ms。補跑 1,602 ticks，每次 wake 最多 2 ticks，積欠峰值／結束為 0／0 |
| Event-loop p50／p95／p99／max | 15.966／20.398／23.265／40.731 ms |
| GC | 697 次，pause p50／p95／p99／max 為 0.681／1.257／2.040／15.901 ms |
| CPU | Server 11.59%，headless 10.99%，相當於各自使用 0.116／0.110 個邏輯核心 |
| RSS／heap | Server RSS 88.95 → 116.77 MiB（樣本峰值 116.77），heap used 24.70 → 28.43（峰值 35.94），heap committed 38.02 → 57.02（峰值 57.52）。Headless RSS 67.27 → 101.09（峰值 101.38），heap used 17.37 → 28.35，committed 21.89 → 55.39 |
| WebSocket | 上行 75.93 KiB/s、601.14 訊息/s；下行 147.66 KiB/s、405.89 訊息/s。每個目標席位約 3.80／7.38 KiB/s；所有房間 ws `bufferedAmount` 峰值 0 |
| 戰鬥 | 1,540 次權威普攻、375 次怪物受傷、130 次角色受傷、93 次死亡完成、94 次重生（含 warmup 開始的死亡），938 次向上起跳 |
| 獎勵與 mutation | 93 筆 reward（0.155/s）、3,720 EXP、724 筆私人 grant。實際入帳 354 筆金幣、370 筆物品、28 次藥水，共 752 次 mutation（1.253/s）。無 retry，pending 最高 1、結束 0，reward latency p95 48.53 ms。Mutation 等待峰值 4、結束 0，p95 46.37 ms |
| 輸入 | 359,813 個 client frames，約 29.98 Hz／席。M1 入列 359,551，凍結拒收 31，交接清退 62，未見 TTL 到期。M1 每角色／聚合 queue 峰值 3／59 |
| 收據與地面 | 角色收據 29 → 781（+752，約 +275.0 KiB JSON payload），receipt hits +158，client 重送 101。地面紀錄 29 → 753，採樣最高 11 件 active，結束皆已拾取。離房釋放 781 筆角色及全部 96 筆死亡收據，753 筆地面終態留在 store 至 process teardown |
| 交接與正確性 | 28／28 次 portal、20／20 次受控重連，檢查 48 個撤銷的舊 bindings。無重複權威 body、重發貨幣／物品／EXP、過期傷害、未結交易、私人外洩、未處理 rejection 或清理殘留 |

M1 每房 tick p50／p95／p99／max 為 0.307／0.653／0.944／3.142 ms。10 Hz `onBeforePatch` 為 0.764／1.491／1.870／3.398 ms。結束時 9／10 隻活怪，Village 0。 [測試入口](../../apps/server/test/run-early-capacity.mjs)

### Stage B · 60 人／3 戰鬥房

| 項目 | 觀察 |
| --- | --- |
| verdict 與樣本 | `VERIFIED`，600.095 秒，119 筆間隔樣本，18,002 ticks |
| 房間與席位 | 3 個 M1 各成功入房 20 人，結束 60 個唯一 active 角色。每房席位峰值 20，reserved 峰值 1。37 個臨時 Village instance，最高 2 席，採樣最高同時 4 房。第 21 席拒絕 522 |
| World tick p50／p95／p99／max | 0.765／1.709／2.636／6.181 ms |
| 到期至 wake p50／p95／p99／max | 19.923／36.798／43.483／54.034 ms。補跑 1,788 ticks，每次 wake 最多 2 ticks，積欠峰值／結束為 0／0 |
| Event-loop p50／p95／p99／max | 15.655／22.577／25.903／44.958 ms |
| GC | 900 次，pause p50／p95／p99／max 為 0.843／1.409／1.920／22.872 ms |
| CPU | Server 26.49%，headless 26.99% |
| RSS／heap | Server RSS 104.36 → 168.81 MiB（峰值 168.81），heap used 28.79 → 29.56（峰值 51.38），committed 56.77 → 94.77（峰值 94.77）。Headless RSS 98.02 → 175.16（峰值 178.35），heap used 25.68 → 40.85，committed 55.64 → 155.14 |
| WebSocket | 上行 227.78 KiB/s、1,803.04 訊息/s；下行 443.82 KiB/s、1,215.47 訊息/s。每目標席位 3.80／7.40 KiB/s。ws queue 峰值 832 bytes |
| 戰鬥 | 5,182 次權威普攻、1,101 次怪物受傷、399 次角色受傷、275 次死亡完成、275 次重生、2,817 次向上起跳 |
| 獎勵與 mutation | 275 筆 reward（0.458/s）、11,000 EXP、2,212 筆私人 grant。實際入帳 1,036 筆金幣、1,180 筆物品、87 次藥水，合計 2,303 次 mutation（3.838/s）。無 retry，pending 峰值 2／結束 0，reward latency p95 47.81 ms。Mutation 等待峰值 8／結束 0，p95 40.99 ms |
| 輸入 | 1,079,173 個 client frames，約 29.97 Hz／席。M1 入列 1,078,418，凍結拒收 75，交接清退 192，無 TTL 到期。M1 每角色／聚合 queue 峰值 4／61 |
| 收據與地面 | 角色收據 68 → 2,371（+2,303，約 +841.81 KiB），receipt hits +525，client 重送 338。地面紀錄 72 → 2,284，採樣最高 14 件 active，結束皆已拾取。離房釋放 2,371 筆角色及全部 284 筆死亡收據，地面終態留下 2,284 筆直到 teardown |
| 交接與正確性 | 78／78 次 portal、60／60 次受控重連。138 個舊 binding 測試均無法操作或查本人資料。無重複／未結交易、過期傷害、私人外洩、未處理 rejection 或清理殘留 |

| M1 房 | Tick p50／p95／p99／max（ms） | Patch p95（ms） | 死亡完成／重生 | 結束活怪／出生數 | 上行／下行（KiB/s） |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.276／0.546／0.790／3.607 | 1.323 | 92／92 | 8／10 | 75.89／147.48 |
| 2 | 0.183／0.394／0.598／1.666 | 1.327 | 91／91 | 9／10 | 75.88／148.11 |
| 3 | 0.166／0.362／0.548／1.384 | 1.338 | 92／92 | 8／10 | 75.87／147.95 |

### Stage C 初次嘗試 · 140 人／7 戰鬥房

| 項目 | 觀察 |
| --- | --- |
| verdict 與時長 | 初始 harness 以 `CORRECTNESS_FAILURE` 停止。依該輪可用證據判定 `INCONCLUSIVE`，共 62.835 秒、1,884 ticks、13 筆間隔樣本 |
| 席位 | 140 人各有唯一 body，7 個 M1 各 20 席，第 21 席拒絕 522 |
| Tick p50／p95／p99／max | 1.619／3.033／3.944／22.741 ms，積欠峰值 0 |
| Event-loop p50／p95／p99／max | 13.271／24.740／30.573／42.959 ms |
| CPU／記憶體 | Server／headless 55.98%／59.51%。Server RSS 113.48 → 154.52 MiB，heap used 39.01 → 31.56，committed 59.52 → 96.27。Headless RSS 138.43 → 145.00 MiB |
| 網路 | 上行 531.36 KiB/s、4,207.35 訊息/s；下行 1,048.89 KiB/s、2,825.87 訊息/s |
| 獎勵與 mutation | 66 筆 reward（1.05/s）、2,640 EXP、505 筆地面 grant、518 筆 mutation（8.24/s）。Pending／mutation 等待峰值 2／8，drain 後均為 0 |
| 收據與地面 | 角色收據 123 → 641，離房後清除。地面紀錄 124 → 629，採樣最高 7 件 active |
| 交接與事件 | 26 次 portal、14 次重連。第 62.84 秒 headless 回報 `Private message received on a stale or foreign socket: MovementCheckpoint`。伺服器端 probe 未發現撤銷的 route 可查本人資料或接收輸入。席位、收據、房間、socket 及 scheduler 都完成清理 |

舊探針對訊息早於本連線的 binding、角色／epoch 不合，以及合法舊 epoch 封包晚於轉場抵達，均回報同一錯誤。第一輪無從用這筆訊息區別。Harness 加入 server `client.send` 的發送時身分與 tick 核對，保留每 socket／訊息類型最近 16 個 stamp。Headless 先檢查接收 socket 的角色／epoch，丟棄已退役 socket 上晚到的封包，再核對是否有撤銷前發送的對應 stamp。跨角色／epoch、撤銷後發送及無法查證的晚到封包仍使階段停止。 [交接契約](../ARCHITECTURE.md#6-map-authoringroom-與-transfer)

### Stage C 重跑 · 140 人／7 戰鬥房

| 項目 | 觀察 |
| --- | --- |
| verdict 與樣本 | `CORRECTNESS_FAILURE`，435.170 秒，87 筆間隔樣本、13,055 ticks。未完成 600 秒 |
| 房間與席位 | 7 個 M1 各成功入房 20 人。終止時 139 active、1 reconnect reserved、0 incoming、140 個唯一 body。單房 active + reserved 峰值 20。67 個臨時 Village instance（各最高 1 席），同時最多採樣到 8 房及 141 個連線。第 21 席拒絕 522 |
| World tick p50／p95／p99／max | 1.552／2.902／3.903／15.606 ms |
| 到期至 wake p50／p95／p99／max | 19.939／38.568／44.499／87.032 ms。補跑 1,449 ticks，每次 wake 最多 3 ticks，積欠峰值／結束均 0 |
| Event-loop p50／p95／p99／max | 13.451／24.494／30.048／60.621 ms |
| GC | 449 次，pause p50／p95／p99／max 為 1.265／2.322／6.476／10.183 ms |
| CPU | Server 54.52%，headless 61.58% |
| RSS／heap | Server RSS 114.69 → 259.54 MiB，heap used 31.74 → 81.16，committed 60.52 → 168.52，三者終點同為採樣峰值。Headless RSS 135.68 → 208.77（峰值 208.77），heap used 28.67 → 46.53（峰值 69.38），committed 94.64 → 170.14 |
| WebSocket | 上行 530.93 KiB/s、4,203.85 訊息/s。下行 1,062.36 KiB/s、2,834.12 訊息/s。每目標席位 3.79／7.59 KiB/s。ws queue 峰值 854 bytes |
| 戰鬥 | 12,073 次權威普攻、1,793 次怪物受傷、774 次角色受傷、448 次死亡完成、447 次重生、4,756 次向上起跳 |
| 獎勵與 mutation | 448 筆 reward（1.029/s）、17,920 EXP、3,471 筆私人 grant。入帳 1,660 筆金幣、1,811 筆物品、167 次藥水，共 3,638 次 mutation（8.360/s）。另 1 次 `STALE_VERSION` 正常拒絕。無 reward retry，pending 峰值 3／結束 0，reward latency p95 49.87 ms。Mutation 等待峰值 8／結束 0，p95 40.63 ms |
| 輸入 | 1,824,905 個 client frames（約 29.95 Hz／席）、262 次凍結拒收、481 次交接清退、TTL 到期 0。M1 每角色／聚合 queue 峰值 4／80 |
| 收據與地面 | 角色收據 101 → 3,740（+3,639，約 +1,324.56 KiB），receipt hits +873，client 重送 513。地面紀錄 100 → 3,571（約 +7.98/s），採樣最高 17 件 active，結束皆已拾取。離房清空 3,740 筆角色及全部 462 筆死亡收據。3,571 筆地面終態留到 teardown |
| 交接與正確性 | 138／139 次 portal 成功，1 次 `522` 與 `TRANSFER_FAILED`。受控重連 102／103 已完成，最後一次在停止時尚未重新綁定，其保留席位於 drain 釋放，無 reconnect 拒絕。撤銷 socket 驗證 240 次，未觀察到私人訊息發送違規、重複授予、未決交易或未處理 rejection |

| M1 房 | Tick p50／p95／p99／max（ms） | Patch p95（ms） | 死亡完成／重生 | 結束活怪／出生數 | 上行／下行（KiB/s） |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.259／0.475／0.672／9.413 | 1.361 | 67／67 | 8／10 | 75.81／147.20 |
| 2 | 0.182／0.369／0.557／6.205 | 1.371 | 65／64 | 8／10 | 75.81／150.21 |
| 3 | 0.169／0.349／0.518／3.113 | 1.346 | 64／64 | 9／10 | 75.79／151.67 |
| 4 | 0.156／0.328／0.490／4.391 | 1.302 | 65／66 | 9／10 | 75.80／151.17 |
| 5 | 0.155／0.328／0.490／6.402 | 1.312 | 64／64 | 8／10 | 75.82／153.02 |
| 6 | 0.154／0.327／0.473／3.058 | 1.273 | 62／62 | 8／10 | 75.78／153.50 |
| 7 | 0.154／0.323／0.484／12.558 | 1.292 | 61／60 | 8／10 | 75.78／154.88 |

### 目的房銷毀 race

重跑未再看到初次的 checkpoint 訊號。這次停止事件同時出現席位／可用性不一致、portal 目的 admission 522 及來源 `TRANSFER_FAILED`。以兩個真實 SDK client 和正式 Room、WorldCoordinator 重現相同的 admission／transfer 結果。診斷程式固定權威 tick 次序，只定位兩個角色到既有 portal，沿用同一地圖資料、預留與 Colyseus 清理路徑。

```sh
pnpm run build
node apps/server/test/reproduce-capacity-transfer.mjs
```

1. 依序從 M1 建立甲、乙；甲進 Village 成為唯一住客。等 Colyseus 的空房計時序列已可釋放房間。
2. 甲準備回 M1，已連到候選 socket。乙排入進 Village 的正常 portal 請求。
3. 推進同一 tick。甲先交接到 M1，舊 Village socket 觸發 `onLeave`，當時 Village 未保有權威席位。乙接著成功預留該 Village 並收到 offer。
4. Colyseus 在等待中的 leave 清理流程檢查空房時釋放 Village。測試在 `disposeRoom` 當下測得 `hasRetainedSeats() === true`，乙的真實 `joinById` 回 `522 room not found`。下一 tick 回報 `TRANSFER_FAILED`，乙仍保有原 M1 body。獨立執行兩次都得到相同結果。

最小修正建議是在目的 MapRuntime 成功預留時，同步更新對應 Colyseus Room 的保留狀態，並在 reservation 消耗或取消時重算。讓同 tick 的離房清理能看到新 reservation，補上上述雙 client 回歸。此問題在兩人就可重現，第一個可證實的阻擋因素是兩個 room lifecycle 的時序；Stage C 截止前未碰到取樣的 tick、網路或 reward backlog 門檻。 [決定性重現程式](../../apps/server/test/reproduce-capacity-transfer.mjs) · [權威預留](../../apps/server/src/runtime/world-coordinator.ts) · [Colyseus Room adapter](../../apps/server/src/adapters/map-room.ts)

## 正確性修正複驗

2026-11-26 以 Node.js 24.22.3／pnpm 11.19.0 在同一台主機複驗。修正前以原重現程式連跑兩次。修正後測試、瀏覽器、耐久和容量量測在隔離目錄使用 `eb05fcf` 的正式遊戲資料和 frozen lockfile，疊加本次房間生命週期修正與回歸測試。

| 修正前原始重現 | 銷毀時狀態 | SDK 入房 | 下一 tick |
| --- | --- | --- | --- |
| 1 · `tPgAmtrK2` | `hasRetainedSeats() === true` | `522 room not found` | 來源收到 `TRANSFER_FAILED`，M1 body 保留 |
| 2 · `DNGccgCjL` | `hasRetainedSeats() === true` | `522 room not found` | 來源收到 `TRANSFER_FAILED`，M1 body 保留 |

另以觀察版程式對未修改的 `eb05fcf` 產物追蹤房間 `uSgSTyaAr`。第 5 個受控 tick，甲已成功提交回 M1。Colyseus 移除甲的 Village socket，執行 `onLeave` 後暫停在非同步清理。此時 Village 為 `CREATED`、已登記、`locked=false`、`autoDispose=true`，權威席位及 transport 席位皆為 0。相同 tick 隨後為乙新增 1 筆 incoming，並送出 `TransferOffer`。Colyseus 的 transport client 和 reservation 仍為 0。離房續行至 `#_decrementClientCount`，`#_disposeIfEmpty` 依 transport 空房且 `autoDispose=true` 發出 dispose。房間進入 `DISPOSING` 並解除登記，`onDispose` 仍記錄 1 筆 incoming 和 `locked=false`。乙的真實 `joinById` 回 `522 room not found`，下一 tick 取消交接並恢復來源。

Colyseus core 0.18.29 的 `hasReachedMaxClients()` 會同時檢查 transport 容量和 `DISPOSING`。目的房預留前檢查此方法及本機 matchmaker 實例身分。MapRuntime 在 incoming 加入、成功交接、取消、過期，以及 grace 保留增減時同步更新 `autoDispose`。候選 socket claim 時仍由來源房持有角色 body。交接提交才將 incoming 換成 active，並撤銷舊綁定。取消、逾時、候選失敗或來源斷線均清理預留。最後一筆保留席位釋放時，Colyseus 恢復內建空房清理。Transport 仍透過 `joinById` 暫留自己的席位，沒有預先配置第二份 transport reservation。 [房間契約](../ARCHITECTURE.md#6-map-authoringroom-與-transfer)

正式產物的雙 client 重現連跑 5 次，全部在 tick 5 經 `TransferOffer` 取得目的 socket，在 tick 6 提交。觀察到新預留當下 `autoDispose=false`、incoming 1、transport client／reservation 均 0。隨後核對同一角色只剩目的 body、舊綁定不能取得私人 checkpoint／背包／地面掉落、Village 真正清空後銷毀。5 次皆無意外 522。 [雙 client 重現](../../apps/server/test/reproduce-capacity-transfer.mjs) · [生命週期測試](../../apps/server/test/transfer-lifecycle.test.mjs)

目前雙 client 重現入口預設驗證修正版。要對基線再次取得逐事件 trace，將該入口與 `transfer-lifecycle-fixture.mjs` 複製至基線 server 的測試目錄，對基線 production build 執行 `node apps/server/test/reproduce-capacity-transfer.mjs --baseline`。

### 回歸檢查

| 指令或環境 | 結果 |
| --- | --- |
| `pnpm exec vitest run` 指定 `transfer-lifecycle`、`world-travel`、`map-room`、`map-runtime`、`ground-loot`、`early-capacity`、`shared-combat` | 7 檔、86 項通過。含真 Colyseus 取消、未 claim／已 claim 逾時、提交前驗證失敗、來源及候選各自斷線、已銷毀房間、新實例、同 tick 多筆預留、20／21 席、舊票／舊回呼與最後一房的排程清理 |
| `pnpm run test`（Vitest 5.1.1） | 40 檔、600 項通過。M5.4 已提交藥水跨房在同一生命套用一次。M5.5 在來源房銷毀之後完成凍結獎勵，40 EXP 只通知目的綁定一次並釋放死亡收據 |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run check:boundaries` | 全部通過，8 個 workspace package dependency boundaries 通過 |
| `pnpm run build` | Server、shared packages、client production build 通過。Vite 主 chunk 659.59 kB，仍出現既有 500 kB 提示 |
| `pnpm run format:check`、`git diff --check` | 工作樹檢查通過。Prettier 沿用既有設定 |
| Playwright 1.65.1／Chromium 159.0.8154.6 | 6／6 通過，約 2.1 分鐘。涵蓋 patch jitter 重連、150 ms RTT 往返交接、延遲目的入房、單人獎勵循環、背包與藥水。原 `2567` 已有服務，驗證使用獨立 loopback server 埠 |

```powershell
pnpm exec playwright test tests/smoke/multiplayer.spec.mjs --workers=1 --grep 'through transfer and reconnect|through rejoin and reconnect|delayed destination join|solo combat loop|across reconnect and transfer'
```

#### 提交前完整驗證（2026-11-26）

使用同一份隔離的正式資料與 production build，單獨執行完整 `pnpm run test:smoke`。Windows 11 build 26200、Node.js 24.22.3、pnpm 11.19.0、Playwright 1.65.1、Chromium 159.0.8154.6。多人組以 1 個 worker 通過 11／11（2.8 分鐘），其餘以 5 個 workers 通過 14／14（48.3 秒），合計 25／25，退出碼 0。驗證使用 loopback server 埠 50414，完整輸出保留於驗證目錄的 `transfer-chromium-full.log`。

以臨時 Git index 核對 17 檔候選差異，涵蓋容量 harness、房間生命週期修正、相關回歸與文件。工作樹的 Slime 基礎 HP 60 → 10 和新手 HP 上限 50 → 5000 原樣保留於候選差異之外。既有 M5.5 驗收狀態更新另保留於工作樹。Roadmap 的候選差異限於容量風險紀錄。工作樹的 `git diff --check` 和候選差異的 `git diff --cached --check` 均通過，實際 Git index 為空。

逐檔核對 server runtime 與容量 harness，與既有成功驗證的版本一致，沿用雙 client 5／5、Stage C 及 M4.5 耐久結果。保留原 Stage C 435.170 秒的 `CORRECTNESS_FAILURE`、兩次基線重現與逐事件 trace。

### 修正後 Stage C · 140 人／7 戰鬥房

從隔離目錄以 `pnpm run build` 後執行 `node apps/server/test/run-early-capacity.mjs --stage C --output stage-c-fixed.jsonl`。同一台 i7-1355U、12 logical CPUs、15.63 GiB、Windows 11 build 26200，使用原 server／SDK 子程序和 loopback。仍為正式 `mvp-1`、protocol 7、相同地圖 hash、seed `20261126`、每 M1 6 Slime 與 4 Mushroom、Village 0 怪。沿用 15 秒 warmup、原 workload 混合、取樣與門檻。Runner 的觀察 wrapper 轉送新的 room lifecycle 參數，量測規則相同。

| 項目 | 修正前 Stage C 重跑 | 修正後 Stage C |
| --- | --- | --- |
| Verdict／實測時長 | `CORRECTNESS_FAILURE`，435.170 秒，87 筆間隔樣本、13,055 ticks | `VERIFIED`，600.056 秒，119 筆間隔樣本、18,002 ticks。Drain 與 shutdown 均通過 |
| Portal／活票 522 | 138／139 成功，1 次 `522 room not found`、1 次 `TRANSFER_FAILED` | 182／182 成功，0 次入房拒絕或 transfer failure |
| 受控重連／舊綁定檢查 | 102／103 已完成，240 筆撤銷檢查 | 140／140 成功，322 筆撤銷檢查 |
| 銷毀房間 | 量測終點 67 間 Village 已銷毀，shutdown 累計 74 間房 | 量測終點 70 間 Village 已銷毀，shutdown 累計 77 間房 |
| Incoming 與席位 | 取樣 incoming 峰值 1，終點 0。單房保留席（grace＋incoming）峰值 1。終點 139 active、1 grace、140 個唯一 body | 取樣 incoming 峰值 1，終點及清理後 0。單房保留席峰值 2。終點 140 active、140 個唯一 body |
| 每房 admission cap | 權威席位峰值 20。第 21 席 `522 room locked` | 權威席位峰值 20。第 21 席 `522 room locked`，為預期探測拒絕 |
| World tick p95／p99／max | 2.902／3.903／15.606 ms | 2.898／3.949／10.338 ms。p95 <20 ms，p99 <33.33 ms |
| Event-loop p95／p99／max | 24.494／30.048／60.621 ms | 24.527／30.523／55.247 ms |
| 排程 | 補跑 1,449 ticks，單次 3 ticks，積欠峰值 0 | 補跑 1,668 ticks，單次 3 ticks，積欠峰值 0 |
| CPU（server／SDK） | 54.52%／61.58% | 51.91%／58.40% |
| Server RSS／heap used（MiB） | RSS 114.69 → 259.54（峰 259.54），heap 31.74 → 81.16（峰 81.16） | RSS 113.25 → 264.63（峰 264.63），heap 35.46 → 60.93（峰 84.22） |
| SDK RSS／heap used（MiB） | RSS 135.68 → 208.77（峰 208.77），heap 28.67 → 46.53（峰 69.38） | RSS 137.53 → 209.84（峰 209.84），heap 46.94 → 56.54（峰 63.69） |
| Reward | 量測期 448 筆，pending 峰 3／終點 0，無 retry，p95 49.87 ms | 量測期 614 筆，pending 峰 3／終點 0，無 retry，p95 48.92 ms。含 warmup 的 628 筆死亡收據皆釋放 |
| 角色收據 | 101 → 3,740（+3,639），增加 1,324.56 KiB，清理後 0 | 112 → 5,146（+5,034），增加 1,833.22 KiB，清理後 0 |
| 地面紀錄 | 100 → 3,571，+7.98 筆／秒，active 峰 17 | 110 → 4,910，+8.00 筆／秒，active 峰 16。結束 active 0，4,910 筆終態留到 teardown |
| 正確性與 drain | 1 次席位／房間可用性不一致。清理後權威席與 socket 歸零 | 容量、重複 body、獎勵與 owner binding 事件皆為 0。席位、mutation、reward backlog、rooms、socket、收據均清理，排程啟停各 1 次 |

有 1 筆在撤銷前已寫出的 `MovementCheckpoint` 晚到，server write tick 17398，舊綁定在 tick 17399 撤銷。原稽核探針查到寫出紀錄，client 丟棄封包。樣本的房間停留時間與戰鬥順序受 socket 時序影響，兩輪時長亦不同。CPU、RSS、吞吐與房間數僅記為各輪觀察值。這次 `VERIFIED` 適用此主機、loopback、memory repositories 和 600 秒混合負載。正式容量依 M8.3 的 PostgreSQL、WAN 與 60 分鐘門檻驗收。

原 Stage C 的 `stage-c.jsonl`、`stage-c-recheck.jsonl`，兩次原重現 `transfer-baseline-1.log`／`transfer-baseline-2.log` 及基線逐事件 trace `transfer-baseline-lifecycle.log` 保留於 `%TEMP%/viesma-capacity-e05b23a6`。修正後 `stage-c-fixed.jsonl`、`transfer-fixed-1.log` 至 `transfer-fixed-5.log`、回歸與耐久輸出保留於 `%TEMP%/viesma-transfer-disposal-96add7ee`。

### M4.5 獨立耐久複驗

Stage C 完成並關閉後，在同一台 Windows 11 主機與正式資料的隔離 build 單獨執行 `pnpm run test:acceptance:m4.5`，使用 Node.js 24.22.3／pnpm 11.19.0。600.040 秒、17,999 ticks、兩房共 4 具角色 body，M1 10／12 隻怪。完成 26 輪角色死亡返村、怪物死亡重生與 Return reset，包含 30 次 fresh join、26 次主動離房和 26 次重連。26 筆獎勵提交並釋放收據，完成 26 次拾取。補跑 3,629 ticks，單次 wake 最多 2 ticks，積欠峰值、結束積欠、待處理意圖及保留收據均為 0。最後一房清理後排程器停止，程序錯誤 0。這項耐久命令使用 runtime peer，真實 transport 生命週期由上述 SDK、Chromium 與 Stage C 測試驗證。 [M4.5 原驗收](M4.md#m45) · [耐久入口](../../apps/server/test/run-shared-combat-endurance.mjs)

## 保留量與後續驗收

- 角色命令收據被角色 lease 保留，角色釋放後回到 0。Encounter 收據隨 encounter 釋放。Ground store 將拾取與到期寫成終態，角色與房間釋放後仍保有 `records`。在這段 workload 裡，地面終態的累積比活躍地面件數更能反映長時間記憶體壓力。RSS 與 V8 heap 也包含 schema、socket、觀察程式和 GC 高水位，不能由收據 JSON 大小換算。 [角色 repository](../../apps/server/src/runtime/memory-character-repository.ts) · [地面 store](../../apps/server/src/runtime/ground-loot.ts)
- M7 須保留原始 receipt、session fencing 與 COMMIT recovery 語意，並以 PostgreSQL 的 async completion 路徑重測 latency 與 queue。這次資料可作記憶體版的對照點，M7 要追蹤 durable ground terminal rows、可重送範圍、鎖等待及安全清理。 [PostgreSQL 契約 spike](PG-CONTRACT-SPIKE.md)
- 基線完整通過 60 人。修正後同一主機在相同 workload 完成 140 人樣本。M8.3 的參考條件為 4 vCPU／8 GiB、分離 PostgreSQL、60 分鐘、7 房與每戰鬥圖最多 12 隻怪，會納入滿房 reservation、DB slow／reward spike、WAN 條件及更長的 retention 觀察。瀏覽器／實機、轉場 RTT 和冷載入各有正式驗收。 [PRD N01–N06](../PRD.md#6-non-functional-requirements) · [M8.3](../ROADMAP.md#m83--loadcapacity-與-balance-tuning)

## 本機驗證

- 35.1 秒 Stage A 校準完成 20 人入房、第 21 席拒絕、6 筆死亡交易、51 件物品／貨幣拾取、2 次 portal 交接和 1 次重連，未見正確性事件。此輪用於確認 workload 和觀察器，時長低於正式 spike 樣本。
- Vitest 5.1.1 focused run 通過 6 檔、80／80，包括 histogram／seat／過期傷害探針、真 Colyseus 入房、reward worker、個人掉落、地面拾取與角色交易。命令如下。

```sh
pnpm exec vitest run apps/server/test/early-capacity.test.mjs apps/server/test/map-room.test.mjs apps/server/test/encounter-reward-worker.test.mjs apps/server/test/ground-loot.test.mjs apps/server/test/personal-loot.test.mjs apps/server/test/character-coordinator.test.mjs
pnpm exec vitest run apps/server/test/early-capacity.test.mjs apps/server/test/world-travel.test.mjs apps/server/test/map-runtime.test.mjs
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run build
```

- 第二批跨房／MapRuntime focused tests 通過 3 檔、40／40，包含重跑 3 項觀察器測試。Typecheck、lint、8 個 package dependency boundaries 及原 LF checkout 的全專案 Prettier 檢查通過。Server、shared packages 與 client production build 通過。Vite 主 chunk 為 659.59 kB，仍觸發既有 500 kB 提示。
- Stage A 後首次 lint 找到 Node globals 未顯式匯入，已修正並刪除未使用的 replay 暫存欄位。Stage B 起使用修正後的 harness。首次格式檢查指出暫存 archive 的 CRLF 及 Node 套件檔，後續在工作樹檢查全部專案並通過。Runtime 產物與採樣規則沿用同一基線。瀏覽器與 M4.5 耐久沿用 M5.5 實作驗收及其遠端 CI。
- Stage C 訊息探針修正後，五個 harness 檔的 ESLint／Prettier 通過，含撤銷邊界的新斷言、WorldCoordinator 交接與 Colyseus 房間測試共 30／30。Stage C 重跑使用 `node apps/server/test/run-early-capacity.mjs --stage C --output stage-c-recheck.jsonl`。
- Stage C 初次嘗試與重跑保留原始 JSONL，包括 435 秒停止後的 drain／teardown。另以 Windows PTY Ctrl+C 中斷短程 Stage A，主控台終止程序群組後未留下 server、load process 或 loopback listen socket。PTY 終止只驗證程序與埠回收；一般結束及正確性中止另有完整 drain 紀錄。

交付包含階段執行入口、headless client、tick／傳輸觀察器、seat／交易稽核、focused tests 及雙 client 重現程式。正式 server 與 game-data 透過已驗證的 SHA 產出。 [階段入口](../../apps/server/test/run-early-capacity.mjs) · [Headless client](../../apps/server/test/capacity-client.mjs) · [觀察器](../../apps/server/test/capacity-observe.mjs) · [稽核](../../apps/server/test/capacity-audit.mjs) · [Focused tests](../../apps/server/test/early-capacity.test.mjs) · [轉場重現](../../apps/server/test/reproduce-capacity-transfer.mjs)
