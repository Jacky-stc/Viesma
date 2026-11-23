# Viesma

Viesma 是原創 2D 橫向多人 RPG。M0.1 提供可獨立建置的 React client 與 Node.js／Colyseus server。開發順序見 [開發路線圖](docs/ROADMAP.md)，套件責任見 [系統架構](docs/ARCHITECTURE.md)。

## 開發環境

使用 `.node-version` 指定的 Node.js 24.22.3 LTS，以及 `package.json` 指定的 pnpm 11.19.0。若已安裝 Corepack，可執行 `corepack enable` 讓 `pnpm` 依專案的 `packageManager` 選用版本。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm dev
```

開啟 Vite 在終端機顯示的本機網址，確認 React 入口顯示 Viesma。Vite 預設使用 `http://127.0.0.1:5173`，若連接埠已被占用，會使用下一個可用的連接埠。Colyseus server 監聽 `127.0.0.1:2567`，啟動後會在終端機顯示網址。開發 shell 只需要 Node.js 和 pnpm。

### PostgreSQL 開發與測試服務

需要資料庫時，啟動支援 Linux 容器的 Docker 與 Docker Compose v2。將 [`.env.example`](.env.example) 複製為根目錄的 `.env`，填入自己的本機開發密碼 `POSTGRES_PASSWORD`。Compose 預設在 `127.0.0.1:5432` 提供 PostgreSQL 18.7，可用 `POSTGRES_PORT` 更換主機埠。使用 `POSTGRES_USER` 與 `POSTGRES_DB` 指定初次建立 volume 時的使用者與資料庫。

```sh
docker compose config --quiet
docker compose up --detach --wait --wait-timeout 90
docker compose ps
```

`up --wait` 會等待 healthcheck 透過容器內的 TCP 連線成功驗證帳密並執行 `SELECT 1`。`docker compose ps` 應顯示 `healthy`。啟動失敗可用 `docker compose logs postgres` 查看原因。`docker compose down` 停止服務並保留 named volume。日後的 PostgreSQL schema、migration 與 transaction 測試由 M7 交付。

`.env` 與其他本機 env 檔由 Git 忽略。資料庫設定使用 `POSTGRES_*`，請保留 `VITE_*` 給可公開到瀏覽器的設定。使用 `config --quiet` 驗證 Compose，避免在終端或 CI 印出解析後的憑證。

## 版本矩陣

| 用途             | 固定版本                                                                                                                                          | 相容性依據                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 執行環境         | Node.js 24.22.3 LTS、pnpm 11.19.0                                                                                                                 | Node.js 24 同時符合 Vite、Colyseus、ESLint 和 pnpm 的 engines。                                                                                                 |
| TypeScript       | TypeScript 6.0.3、`@types/node` 24.19.2                                                                                                           | TypeScript 6.0 在 typescript-eslint 支援範圍內，Node 型別對齊執行環境的 major。                                                                                 |
| Client           | React／React DOM 19.3.1、兩者的型別 19.3.0、Vite 8.3.8、React plugin 6.3.0、PixiJS 8.23.0                                                         | React DOM 的 React peer 與兩者的型別吻合，React plugin 支援 Vite 8。Client 預設使用 Vite 的瀏覽器建置目標。                                                     |
| Colyseus         | `@colyseus/core` 0.18.29、`@colyseus/ws-transport` 0.18.5、`@colyseus/sdk` 0.18.10、`@colyseus/schema` 5.0.50                                     | Core、transport 和 SDK 使用相容的 0.18 系列，Core 和 SDK 共用相容的 Schema 5。WebSocket transport 的 Express peer 固定為 5.3.0，`@types/express` 固定為 5.0.6。 |
| 品質檢查         | ESLint 10.15.0、`@eslint/js` 10.0.1、typescript-eslint 8.73.0、Prettier 3.10.1、organize-imports 4.3.0、tailwindcss 0.8.1（兩者為 Prettier 外掛） | typescript-eslint 支援 ESLint 10 與 TypeScript 6.0。格式設定採專案預設 Prettier 基線。                                                                          |
| 測試             | Vitest 5.1.1、Playwright Test 1.65.1                                                                                                              | Vitest 使用現有的 Vite 8.3.8。Playwright 安裝與所選版本配套的 Chromium。                                                                                        |
| Persistence 選型 | PostgreSQL 18.7、Drizzle ORM 0.45.4、Drizzle Kit 0.31.11、`pg` 和 `@types/pg` 8.23.1                                                              | Drizzle 的 Node PostgreSQL adapter 支援 `pg` 8。JavaScript 套件版本固定在 `persistence` catalog，供後續 workspace package 透過 `catalog:persistence` 引用。     |

官方相容性依據見 [Node.js 發行週期](https://nodejs.org/en/about/previous-releases)、[Vite 指南](https://vite.dev/guide/)、[Colyseus 0.18](https://docs.colyseus.io/migrating/0.18)、[Drizzle PostgreSQL 指南](https://orm.drizzle.team/docs/get-started-postgresql)及 [PostgreSQL 支援版本](https://www.postgresql.org/support/versioning/)。套件的 engines 與 peer ranges 以所選 npm 發行版的 metadata 為準。

Client 原始碼的 `tsconfig.json` 使用 `skipLibCheck`，以相容 PixiJS 與 Colyseus SDK 的上游 `.d.ts`。各 app 的原始碼依共用設定做 strict 型別檢查。Server 以從 Node `Headers` 建構子推導出的 `HeadersInit` 及 `@types/debug` 4.1.13 補齊 Colyseus 宣告所需型別。pnpm 略過選用的 `msgpackr-extract` 原生安裝腳本。

## 後續採用的基線

- **Colyseus adapter** 使用 `Server` 搭配 `WebSocketTransport`。M3.1 的 `Room` 負責 Schema 投影，`patchRate` 設為 100 ms。單一應用層排程器驅動 30 Hz simulation，room 以排程結果更新投影。相關 API 見 [Colyseus Server](https://docs.colyseus.io/server)及 [Colyseus Rooms](https://docs.colyseus.io/room)。
- **瀏覽器與裝置** 暫定 desktop 為 Windows 11 和 macOS 15，mobile 為 iOS 18.4 和 Android 12。實機取樣暫定 iPhone 11／Safari 和 Pixel 6a／Chrome，landscape 參考 viewport 為 667 × 375 CSS pixels，WebGL 為基線且 DPR 上限為 2。M8.2 實測並鎖定裝置與版本。
- **部署** 採單一 region、單一 Node.js 程序，由 reverse proxy 提供 HTTPS／WSS，PostgreSQL 18.7 使用 durable volume 或同區 managed service。實際 hosting 和備份演練由 M8.4 決定。

## 驗證

以下為 GitHub Actions `verify` job 和本機共用的檢查順序。CI 在 push、pull request 與手動觸發時執行，每個檢查各有獨立步驟。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run check:boundaries
pnpm run test
pnpm run build
```

Client build 會檢查輸出的 JavaScript chunks 是否含 server 或 persistence 模組。成功時兩個 app 各自在 `dist/` 產出建置結果。

### Domain 與 simulation 驗證

M0.2 的五個共用套件透過 `@viesma/*` 公開入口匯入。TypeScript 解析 source types，production Node 與 Vite 解析 `dist/` 的 JavaScript。Vitest 在 Node 環境將 domain 與 simulation 的公開套件名稱映射至各自的 TypeScript 入口，可在 build 前執行。

```sh
pnpm --filter @viesma/simulation run test
```

`lint` 檢查 source import 邊界，並在最後執行 workspace dependency graph 檢查。純單元測試置於 `apps/*/test/` 或 `packages/*/test/`，檔名以 `.test.ts` 或 `.test.mjs` 結尾。Simulation 的 headless harness 注入 clock、seed 與 ID，覆蓋 30 Hz 時序、固定 delta、catch-up 與重播。

### App smoke

Build 完成後，先安裝 Chromium，再執行 smoke 測試。

```sh
pnpm exec playwright install chromium
pnpm run test:smoke
```

Playwright 會啟停 production preview 與 Colyseus server，驗證 Chromium 顯示 Viesma，以及 `/__healthcheck` 回傳 HTTP 200。先關閉占用本機 4173 或 2567 埠的程序。CI 或缺瀏覽器系統套件的 Linux 可執行 `pnpm exec playwright install --with-deps chromium` 安裝 Chromium 和系統套件。

CI 接著以一次性密碼執行上述 PostgreSQL health smoke，並清理由該 job 建立的容器與 volume。
