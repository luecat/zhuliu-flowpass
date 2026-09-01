# FlowPass 本機 + LINE 正式可用設計

## 目標

讓使用者可從 LINE LIFF 開啟 FlowPass，完成 LINE 登入、建立申請草稿與保存四題答案；正式網域只負責 DNS，服務與資料仍在本機。

## 已確認邊界

- 公開入口：`https://flowpass.luecat.com/app/apply`
- LINE Login Channel ID：`2011336492`
- LIFF ID：`2011336492-ay7OJ4mO`
- 本機公開服務：`127.0.0.1:38100`
- 本機資料庫：SQLite，沿用既有 migration、加密欄位與 Keychain 參照
- 網域：Daniel Cloudflare zone 只保留 CNAME 到 Daniel Tunnel；不把網站搬到 Cloudflare Worker
- LUECAT：保留已建立的 D1 `flowpass`，本階段不接入，避免混用兩套資料來源

## 架構

Cloudflare Tunnel 將 `flowpass.luecat.com` 轉送到本機 Next public server。Next API routes 透過一個受信任的啟動組合載入 SQLite、FieldCrypto、LINE session service 與 DocumentVault；瀏覽器只取得 LIFF 公開 ID，Channel Secret 僅由本機 Keychain 提供。LIFF 以 `liff.getIDToken()` 將 ID token 送到 `/api/v1/sessions/line`，成功後由既有 cookie/CSRF/idempotency/ETag 流程保存草稿。

## 啟動與復原

新增單一 public runtime bootstrap，明確檢查資料根目錄、正式 origin、LINE secret 參照與加密 keyring；缺任何必要秘密時服務 fail closed 並回健康檢查失敗。啟動腳本與 cloudflared 使用 launchd，Mac 重開後自動恢復；不覆蓋 data、vault、backups。

## 驗證

- focused tests：runtime composition、missing-secret fail-closed、LINE bootstrap/exchange、case/answers autosave
- typecheck、lint、full test、fresh public build
- 本機 HTTPS：`/app/apply` 回 200
- 透過正式網址檢查 `/api/v1/sessions/line` 在缺少 token 時回預期驗證錯誤，而不是 503
- 在真實 LINE LIFF 中登入並建立一筆草稿（不提交敏感文件）

## 明確不包含

- 本階段不把 SQLite schema/repositories 改寫成 D1 API。
- 不把 Channel Secret、session cookie、加密 key 或資料庫內容寫入 Git、DNS 或前端 bundle。
