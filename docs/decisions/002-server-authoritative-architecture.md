# ADR-002 — 採用 server-authoritative architecture

- 狀態：Accepted，Task 0 架構基線。
- 日期：2026-11-23。
- 適用範圍：movement validation、shared combat、progression、party、loot、inventory 與 sessions。

## 背景

共享怪物、多人同時命中、AP、個人裝備與持久化 economy 不能由各 client 各自決定。只有驗證「damage 看起來合理」仍無法防止 duplicate death／pickup 或不同 client 對 HP 的分歧。另一方面，desktop／mobile 需要即時操控感，不能每次走動都等待 round-trip。

## 決策

Server 以30Hz fixed simulation 擁有 player collision／HP／MP、monster AI／HP、combat timing／hitbox、contribution、party eligibility／EXP、loot roll 與 inventory mutation。Client 只送 bounded InputFrame 與 domain requests，不送可信 damage、EXP、position 或 bag snapshot。

Client 使用同 physics 做 local movement prediction，依 server checkpoint／lastProcessedInputSeq 重播；remote entities 以100ms buffer 插值。Server 初期不做 lag compensation。Colyseus 管 transport／Schema projection；domain model 與 authority 不綁定 Room／Schema。

經濟 commands 透過角色 coordinator、PostgreSQL transaction、unique receipt 與 after-commit notification 生效。所有 socket／map handoff 使用 sessionEpoch、connectionEpoch、mapEpoch，避免舊 client 在新 room 繼續 mutation。MVP-A local authority 是測試 adapter，不能作為 production 信任模型。

## 考慮過的方案

- **Client authority／只回報結果**：實作快，但共享 HP、economy 與作弊防護無共同真值。
- **Peer-to-peer lockstep**：不適合不受信任的 browser peers、斷線或中心化持久化；全世界 deterministic replay 成本過高。
- **Server authority，完全無 prediction**：資料一致，但 latency 直接傷害平台跳躍手感。

## 影響

需要 prediction／reconciliation、輸入序列、payload validation、server load 與 transaction coordination。可接受的暫定限制是高 latency 時近戰使用 server 當下 hitbox，client 預先 swing 不代表已命中；以 M3 與 M8 的實測決定是否日後需要回溯。

## 驗證與重評

M3 先驗證雙人 movement／shared entity；M4 驗證 simultaneous combat；M7 驗證 transaction／session；M8.1 驗證 payload forgery、input flood、duplicate events 與20人共享狀態。Authority 不因延遲或 client platform 而降低。

相關文件：[ARCHITECTURE §3–§9](../ARCHITECTURE.md)、[GAME_DESIGN](../GAME_DESIGN.md)。官方參考：[Colyseus State Synchronization](https://docs.colyseus.io/state)。
