# 竹流 FlowPass 技術架構說明

> 依據 `site/` 目前原始碼的靜態比對整理（2026-09-16）。不含測試通過數、建置結果或線上服務狀態，這些需另行實際驗證。

---

## 1. 系統定位

FlowPass 由兩個領域組成：**AI 資料流向護照**，以及**青年 AI 工具補助申請流程**。

一件案件擁有一本護照。護照以版本累積，既有版本是不可變更的歷史紀錄。

主要流程：

1. 申請人從 LINE 進入 LIFF 網頁，回答問題。
2. 生成式模型產生護照草稿，必要時提出追問。
3. 申請人確認草稿、完成補件，送出案件。
4. 管理員審查，要求補正或補件，依確定性規則做出行政決定並核定金額。
5. 系統以 LINE 發送通知。
6. 管理員可發布 AI 工具的資安事件，系統比對受影響的護照並通知申請人。

生成式模型只負責草稿、追問與說明。資格、核准、駁回與補助金額由確定性規則與管理員決定。

---

## 2. 進程拓撲

三個 Node.js 進程，共用同一個 SQLite 資料庫與加密文件庫。全部只監聽本機回送位址。

| 服務 | 技術 | 位址 |
|---|---|---|
| 公開服務 | Next.js 16 | `127.0.0.1:38100` |
| 管理服務 | Hono API + Vite 建置的 React SPA | `127.0.0.1:38101` |
| Worker | Hono 健康檢查 + 佇列處理 | `127.0.0.1:38102` |

對外流量經 Cloudflare Tunnel 進入公開服務。模型端以 Gemini 為主，本機 LM Studio 為備援（`127.0.0.1:1234`）。

請求路徑：

```text
LINE / LIFF 瀏覽器
  → Cloudflare Tunnel
  → Next.js 頁面與 API（回送位址）
  → SQLite 命令與查詢服務
  → 持久化工作佇列
  → Worker
       → 模型轉接層（Gemini 主要，LM Studio 備援）
       → LINE Messaging API

管理介面
  → 僅限回送位址的 Hono 管理 API
  → 同一個 SQLite 資料庫與加密文件庫
```

---

## 3. 公開服務（Next.js）

### 3.1 頁面

App Router。申請人頁面位於 `app/app/` 底下：`apply`、`passports`、`tasks`、`tool-check`。另有公開的 `app/tool-status/`。申請人 UI 元件集中在 `app/components/public/`。

`app/studio/` 是舊版相容路徑，不是主要的申請人流程。

前端以 LINE LIFF SDK 取得身分，再呼叫 session 端點交換成伺服器端 session。

### 3.2 API

統一前綴 `/api/v1/`：

| 資源 | 路由 |
|---|---|
| Session | `sessions/line`、`sessions/line/bootstrap`、`sessions/current` |
| 案件 | `cases`、`cases/[caseId]` |
| 案件子資源 | `answers`、`ai-drafts`、`passport`、`confirmations`、`purchase-details`、`documents`、`submission`、`timeline`、`rules`、`safety-card`、`alerts` |
| 任務 | `tasks`、`tasks/[taskId]`、`tasks/[taskId]/complete` |
| 其他 | `passports`、`documents/[documentId]/download`、`jobs/[jobId]`、`programs/current`、`tool-status` |

### 3.3 授權分層

`proxy.ts` 只設定安全標頭，不做存取控制判斷：

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=()`
- `Cross-Origin-Opener-Policy: same-origin`

CSP 刻意留空，待 LIFF 應用的實際來源確認後再設定，避免誤設的允許清單破壞 LIFF 容器。

資源擁有權檢查落在各路由的服務層與 repository 層。`app/api/v1/owned-resource-routes.test.ts` 針對這個邊界做驗證。

### 3.4 快取

- `/app/*` 頁面：`Cache-Control: private, no-store, max-age=0, must-revalidate`，並附 `Pragma`、`Expires`
- session、護照、文件下載等 API 回應：`no-store`

### 3.5 LINE Webhook

`app/webhooks/line/route.ts`：

1. 未設定 channel secret 時回 503。
2. 以原始 bytes 驗證 `x-line-signature`，失敗回 401。
3. 交由 `server/services/line-webhook-service.ts` 寫入 `line_webhook_events`，以 LINE 事件 ID 作為唯一鍵去除重複。
4. 排入工作佇列，回傳接受與重複的筆數。

Webhook 本身不做業務處理。`line_webhook_events` 只保存事件 ID、類型、**payload 雜湊**與處理狀態，不保存訊息內容。

---

## 4. 管理服務

`server/admin/`（Hono API）與 `admin/`（Vite + React SPA，自訂 CSS，未使用 Tailwind）。

功能涵蓋案件審查、資料管理、補助方案設定、工具目錄、資安事件發布、AI 使用狀況。

存取控制兩種模式：

- **本機**：限定 `127.0.0.1:38101`，使用管理員帳號、session 與 CSRF token
- **遠端**：必須通過 Cloudflare Access 驗證，並檢查 Host 與 Origin

啟動時從 macOS Keychain 載入欄位加密金鑰。Keychain 鎖定時，健康檢查、登入與唯讀路由仍可使用，需要解密的功能不啟用。

管理端回應一律 `Cache-Control: no-store`。

---

## 5. Worker 與工作佇列

`server/worker/`。佇列以資料庫實作，具持久性。

工作類型三種（`server/db/repositories/jobs.ts`）：

| 類型 | 用途 |
|---|---|
| `ai_draft` | 產生護照草稿 |
| `line_webhook` | 處理 LINE 事件 |
| `line_notification` | 發送 LINE 通知 |

`QueueDispatcher` 依類型分別租用工作，記錄嘗試次數與上限，完成或失敗都寫回資料庫。進程重啟後工作不遺失。

**處理為明確 opt-in**：Worker 預設只啟動健康檢查服務，必須設定 `FLOWPASS_WORKER_RUN=1` 才會讀取憑證並呼叫模型。這確保啟動本機健康檢查不會觸及任何密鑰。

模型轉接層（`server/adapters/`）：

- **Gemini**：`GeminiQuotaRouter` 在多個模型間分配額度，逾時 120 秒
- **LM Studio**：OpenAI 相容介面，逾時 300 秒（本機 9B GGUF 模型首次推論產生完整護照 schema 可能超過兩分鐘）

以環境變數 `FLOWPASS_MODEL_ID` 與 provider 設定切換，不需改動程式碼。每次模型呼叫記錄於 `ai_runs`。

---

## 6. 資料層

SQLite，透過 better-sqlite3 同步存取。Schema 以編號 migration 管理（`server/db/migrations/`），存取邏輯集中於 `server/db/repositories/`。

### 6.1 Schema 層級的完整性檢查

- **ID**：CHECK 限制為小寫 UUIDv7（含長度、字元集、版本與 variant 檢查）
- **時間**：CHECK 限制為 `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` 的 UTC RFC 3339
- **外鍵**：時間軸、護照版本等採 `ON DELETE RESTRICT`

### 6.2 不可變歷史

以觸發器阻擋更新與刪除的資料表：

| 資料表 | 保護 |
|---|---|
| `timeline_events` | 禁止 UPDATE、DELETE |
| `passport_versions` | 禁止一般 UPDATE、DELETE；管理操作僅能改非結構欄位 |
| `answer_versions` | 同上 |
| `ai_runs` | 禁止 UPDATE、DELETE |

違反時 `RAISE(ABORT)`。管理員的資料操作只能走受限路徑，結構欄位不可變更。

### 6.3 敏感資料

- **欄位加密**：AES-256-GCM（`server/crypto/field-crypto.ts`），支援金鑰輪替
- **查詢索引**：需比對的值（如 LINE 使用者 ID）另存 HMAC，不存明文；輪替後保留舊 HMAC 候選值以維持可查
- **主金鑰**：存於 macOS Keychain，透過 `server/crypto/keyring.ts` 於啟動時載入
- **附件**：加密文件庫（`server/services/document-vault.ts`），實體檔案存於 `vault/`
- **日誌**：`server/logging/redact.ts` 遮蔽敏感值

### 6.4 並行與重送

- `api_idempotency_keys` 表處理重送請求（記錄 scope、key、request 雜湊與回應）
- 護照更新以 ETag 做樂觀並行控制，不符時回 `ETAG_MISMATCH`

---

## 7. 領域邏輯

集中於 `server/domain/`，多為不依賴框架的純函式或服務。

### 7.1 案件狀態機

`server/domain/case-state-machine.ts`，11 個狀態：

```text
draft → submitted → under_review
under_review → awaiting_documents | returned_for_correction | approved | rejected
awaiting_documents | returned_for_correction → resubmitted → under_review
approved → awaiting_disbursement → disbursed → closed
rejected、closed 為終止狀態
```

動作包含 `submit`、`start_review`、`request_documents`、`return_correction`、`approve`、`reject`、`await_disbursement`、`disburse`、`close`、`manual_override`。

部分動作必須附理由。錯誤碼包含 `FORBIDDEN_TRANSITION`、`REASON_REQUIRED`、`APPROVED_AMOUNT_EXCEEDS_CAP` 等。

### 7.2 護照生命週期

`server/domain/passport-lifecycle.ts`，工作流程狀態：

```text
ai_drafting → follow_up_required → needs_applicant_confirmation → confirmed → locked
```

每次變更新增一個版本，記錄來源：`ai_draft`、`applicant_revision`、`admin_supplement`，並保留父版本 ID、schema 版本、答案版本 ID 與方案規則版本 ID。

相關模組：`passport-validation.ts`（依 JSON schema 驗證）、`passport-indexes.ts`（重建索引）。

### 7.3 確定性規則

| 模組 | 內容 |
|---|---|
| `eligibility-rules.ts` | 檢查送件日期與購買日期是否落在方案期間內，輸出 `pass` / `fail` / `missing` |
| `subsidy-calculator.ts` | 以萬分比（rateBps）計算，套用上限與取整（`floor` / `half_up`），輸入須為安全整數 |
| `contextual-risk-rules.ts` | 依個資、健康資料、公開發布目的地、插件使用、刪除期限、存取控制、去識別化產生風險標記（low / medium / high） |

規則結果附帶規則版本 ID 與輸入快照雜湊，事後可重現判斷依據。

### 7.4 AI 輸入安全

`server/domain/ai-input-safety.ts` 以規則比對偵測申請人輸入中的攻擊樣式，涵蓋中英文：

| 類別 | 說明 |
|---|---|
| `instruction_override` | 忽略／覆寫先前指令 |
| `role_impersonation` | 冒充 system / developer / assistant 角色 |
| `prompt_exfiltration` | 誘導輸出提示詞 |
| `control_markup` | 控制標記 |
| `secret_request` | 索取序號、授權碼等（含「請扮演我奶奶念序號」類手法） |

命中時停止產生，申請人維持可編輯狀態。申請人輸入一律視為不可信的證據，不是模型指令。

### 7.5 其他領域模組

- `timeline-service.ts`：寫入案件時間軸事件（含 `sequence_no` 單調序號）
- `safety-card.ts`：由護照內容產生給申請人看的安全提示卡
- `incident-match.ts`：比對資安事件與護照使用的工具
- `line-intent.ts`：以規則判斷訊息意圖，種類為 `faq`、`subsidy_policy`、`case_status`、`subsidy_amount`、`tool_status`、`fallback`
- `line-session-service.ts`、`session-service.ts`：session 管理

LINE 只提供登入、入口、通知、聊天回覆與深層連結。申請表單與護照流程在 LIFF 網頁，不是 LINE 聊天問卷。

---

## 8. 共用契約

`shared/` 存放跨邊界共用的型別與 schema：`passport-contract.ts`（含 `PASSPORT_JSON_SCHEMA`、`NODE_KIND_GUIDE`）、`timeline-contract.ts`、`rule-contract.ts`、`security-contract.ts`、`api-contract.ts`、`approved-ai-tools.ts`。

執行期驗證使用 Zod。（`package.json` 宣告了 `ajv`，但原始碼中沒有引用。）

---

## 9. 建置與部署

### 9.1 建置

| 指令 | 內容 |
|---|---|
| `build:public` | Next.js，`output: 'standalone'`，`better-sqlite3` 列為 external |
| `build:admin` | Vite 建置管理 SPA 至 `dist/admin` |
| `build:bundles` | tsup 打包 admin、worker、backup、model-runtime 為 ESM（Node 22），並複製 migration 至 `dist/server/migrations` |
| `package:release` | 以上全部，再打包成 release 目錄 |

tsup 設定 `clean: false`，因為 admin 的 Vite 產物共用 `dist/`。

### 9.2 執行環境

macOS LaunchAgent：

| 服務 | Label |
|---|---|
| 公開 | `com.luecat.flowpass.public` |
| 管理 | `com.luecat.flowpass.admin` |
| Worker | `com.luecat.flowpass.worker` |
| LM Studio | `com.luecat.flowpass.model` |
| Cloudflare Tunnel | `com.luecat.flowpass.tunnel` |
| 備份 | `com.luecat.flowpass.backup`（每日 03:15） |

**LaunchAgent 執行的是 `~/Library/Application Support/FlowPass/releases/current` 的打包 release，不是 `site/` 原始碼目錄。** 原始碼變更必須重新建置並切換 release 才會生效。

模型 provider 與 model ID 來自各 plist 的環境變數。

### 9.3 設定與密鑰

| 指令 | 用途 |
|---|---|
| `configure-local` | 只寫入非密鑰設定 |
| `secrets` | 互動式綁定 Keychain 參照 |
| `keychain:doctor` | 檢查 Keychain 狀態 |
| `admin:bootstrap` | 建立本機管理員帳號 |
| `ops:doctor` | 營運狀態檢查 |
| `backup` / `restore:check` | 備份與還原檢查 |

### 9.4 開發

`npm run dev` 以 `concurrently` 同時啟動三個 watch 進程。Worker 需另外設定 `FLOWPASS_WORKER_RUN=1` 才會實際處理工作。

---

## 10. 工程實務

- **TypeScript**：`strict: true`，路徑別名 `@/*`
- **測試**：Vitest（單元）、Testing Library + jsdom（React 元件）。測試檔與原始碼並置，約 110 個測試檔對應約 179 個原始檔
- **靜態檢查**：ESLint 9 + `eslint-config-next`

---

## 11. 已知限制與取捨

- **資料庫綁定 SQLite**：同步存取模式，migration 大量使用 SQLite 專屬語法（`GLOB`、`strftime`、`RAISE(ABORT)` 觸發器）。更換資料庫需重寫 migration 與部分 repository。
- **部署綁定 macOS**：依賴 LaunchAgent 與 Keychain，沒有容器化設定。
- **端對端測試未建立**：`@playwright/test` 已安裝、`test:e2e` 指令存在，但沒有設定檔與測試檔。
- **CSP 未設定**：待 LIFF 應用來源確認後補上。
- **未使用的依賴**：`ajv` 已宣告但無引用；Tailwind 只出現在根目錄 `vite.config.ts` 的 Vinext 預覽設定，正式的 Next.js 建置沒有 PostCSS 設定，樣式為手寫 CSS。
- **Vinext / Sites 預覽設定**存在，但不是生產部署目標。
