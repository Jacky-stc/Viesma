# ADR-004 — Party EXP attribution 與 personal loot

- 狀態：Accepted，Task 0 架構基線；平衡參數待實測。
- 日期：2026-11-23。
- 適用範圍：competing groups、eligibility、rounding、loot ownership 與 idempotency。

## 背景

Party 為 MVP 必需，不能把單人 reward 直接複製給每一 party，否則一隻 monster 會對 unrelated groups 重複發放完整 BaseEXP。需要避免 idle leech、尾刀爭議、加入／離隊搬移 credit、地上物品搶奪與重複拾取。

## 決策

完整且具約束力的規則見 [GAME_DESIGN §6–§7](../GAME_DESIGN.md)，本 ADR 只記錄取捨：

1. EffectiveDamage 不超過 monster 當下剩餘 HP；每角色 first positive hit 鎖定 solo／party group。Party 用 membershipToken 識別本次 membership tenure，離隊重入不能保留 eligibility。
2. Death snapshot 檢查 alive、connected、同 instance、≤640距離、累積≥ceil(1% MaxHP)、最近傷害≤15秒與 group lock。MVP 沒有 support credit；必須親自打出傷害。
3. 全部 groups 先按 damage proportion，以 largest remainder 將**單份** monster BaseEXP 分完。無 eligible members 的 group pool 作廢，不移給其他組。
4. 對每個 eligible party pool 套 `PartyBonus = 1 + 0.1×(N-1)`、`IndividualEXP = floor(Pool×PartyBonus/N)`。需求公式的 BaseEXP 指分配到該組的 pool；N 是 eligible count。Solo 為 N=1。Floor residue 捨去，bonus 不在無關組間重複 baseline。
5. 相同 eligible set 各自獨立抽完整 loot table，不按 damage share 或 party bonus 改 roll。Ground loot 有唯一 ID／owner／expiry，只有 owner 收到 payload 並能 pickup。
6. Server freeze outcome＋balanceVersion；DB 用 unique death／grant／loot keys 與原子 transactions 防止 retry 重發。先 commit，才發成功通知。

## 考慮過的方案

- **Last hit 取得完整 EXP／loot**：促進搶尾刀，不能反映協力傷害。
- **每 party 完整 BaseEXP**：多組 tag 放大 baseline，與單次 death 的資源來源不一致。
- **只按個人傷害均無 party bonus**：可守恆，但弱化組隊，亦不符合產品指定公式。
- **只要同圖就共享 party rewards**：idle leech 與無意義移動可輕易達成，故採近期實際傷害門檻。
- **Shared ground drops／骰裝**：需要 ownership 競爭、分配 UI 或 trading，超過 MVP；personal loot 可直接測試隔離。

## 影響

Same-party eligible members 均分 pool，低 damage 只要過門檻仍可均分；切換 party 可能使當次 credit 作廢。Cap player 仍占 eligible count但 EXP 丟棄。Personal rolls 可使20人共同參與增加裝備供給，這是明確平衡風險，需 M8.3 量測。1%、15秒、640、10% bonus、loot率與120秒 expiry 都是 config，不能散落於 handler。

## 驗證與重評

M6.3 必須包含所有 GAME_DESIGN examples、pool conservation、rounding tie、mixed solo／parties、idle／distance／recentness、roster change／cap／overkill。M6.4 檢查 recipients 與 private payload；M7.4 驗證同 death／pickup retries 與 PG race。要改 eligibility 或 attribution 時須同步此 ADR 的 successor、共同規格與 fixtures，不能只調 client 顯示。
