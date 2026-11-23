# ADR-007 — MVP 使用單節點部署

- 狀態：Accepted，Task 0 架構基線；容量待 benchmark。
- 日期：2026-11-23。
- 適用範圍：server process、rooms、PartyService、admission、deployment 與 operations。

## 背景

初版是七張區域、每 map instance 最多20人的有限 PvE。Multi-node 會需要跨 process party state、room registry、session fencing、分散式 presence 與 reward coordination；在 gameplay 尚未驗證前增加這些系統，無助於及早交付可玩的 loop。

## 決策

單 region、單 Node.js process 同時提供 HTTP 與 Colyseus rooms；process-wide WorldCoordinator／PartyService／CharacterCoordinator。Reverse proxy 提供 same-origin HTTPS／WSS 與 static client，PostgreSQL 使用 durable volume 或 managed instance。Docker／Compose 為開發、staging 與初期部署工具；不需 Redis、Node cluster、Kubernetes、microservices 或多 replicas。

Application seat registry 管 room20人上限、reconnect／incoming reservations 與全 node admission。暫定 node cap140 unique characters、14 rooms；transfer 角色在 node 只算一次，來源／目的 room 各占 seat。140 是待實測目標，未通過 M8.3 必須下修，不能把每房限制當全系統容量保證。

Party／monster runtime 在 restart 清除；persistent progress／loot grants／receipts 從 PG 恢復。Graceful drain 停新 admission／combat、排空 mutations、關閉 connections。非無縫更新，MVP 允許有公告的維護中斷。

## 考慮過的方案

- **多 Node processes／replicas**：增加 CPU scale，但需共享 presence、跨 room coordination 與 session fencing；目前沒有量測證據需要。
- **每功能 microservice**：多個可用性與 transaction 邊界不適合初期 economy 正確性。
- **純單機／無 central server**：無法滿足 shared monsters 與 persistent multiplayer。

## 影響

Node／host 故障會使所有 rooms 斷線，沒有 automatic failover。Database transactions 保護已提交狀態，備份保護 durable storage 災難；兩者不能互相替代。需要 liveness／readiness、tick／DB metrics、admission cap、backup retention 與 restore drill。

保留 opaque mapInstanceId、repository ports、party ownership 與 protocol version，將來可在有容量證據後另立 multi-node ADR。現在不建立 distributed coordinator 或假想 sharding layer。

## 驗證與重評

M3 建立真實 room handoff；M8.3 以4vCPU／8GiB基準、7×20 players、每戰鬥圖≤12 monsters跑60分鐘，量測整 process tick／bandwidth／DB；M8.4 驗證 deploy／drain／restart／restore。若降低 capacity 或優化後仍不足以滿足有證據的需求，再評估 multi-node，不在本 MVP 自動擴大範圍。

相關文件：[PRD N01／N06](../PRD.md)、[ARCHITECTURE §6／§11](../ARCHITECTURE.md)、[ROADMAP M8](../ROADMAP.md)。
