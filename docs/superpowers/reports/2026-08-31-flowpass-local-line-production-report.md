# FlowPass 本機 + LINE 交付報告

## 已完成

- `flowpass.luecat.com` 由 Daniel 帳戶 DNS + Tunnel 轉送至本機 `127.0.0.1:38100`。
- 本機公開服務改由 Node 啟動器先載入 SQLite、FieldCrypto、Keychain 與 LINE session runtime，再啟動 Next。
- runtime 使用 `globalThis` registry，確保 Next production route bundles 共用同一份服務依賴。
- 公開 LINE Login Channel ID：`2011336492`。
- 公開 LIFF ID：`2011336492-ay7OJ4mO`。
- 本機設定已寫入 `~/Library/Application Support/FlowPass/config/config.json`，資料庫仍在本機 SQLite。
- 已產生並保存 `FlowPass/flowpass-master-key` Keychain 主密鑰；密鑰未進 Git、DNS 或前端 bundle。
- 已建立目前有效的示範方案，登入後可建立第一筆申請草稿。

## 驗證

- `npx tsc --noEmit --incremental false`：通過。
- 完整 Vitest：97 files / 346 tests 通過。
- `npm run lint`：通過。
- `npm run build:public`：通過。
- `https://flowpass.luecat.com/app/apply`：HTTP 200。
- `https://flowpass.luecat.com/api/v1/programs/current` 未登入：HTTP 401（正常安全邊界）。
- `https://flowpass.luecat.com/webhooks/line` 未設定 Channel Secret：HTTP 503（安全停用 webhook，不影響 LIFF ID-token 登入主流程）。

## 尚需在 LINE Console 完成

1. LINE Login Channel 的 LIFF app Endpoint URL 設為 `https://flowpass.luecat.com/app/apply`。
2. Scope 至少勾選 `openid`；若要顯示 LINE 基本身份資訊再勾選 `profile`。
3. 若要啟用 webhook，再以本機互動命令把 Channel Secret 放進 Keychain：

```text
npm run secrets -- set line-channel-secret
```

輸入後不會寫入專案檔案。完成後重啟公開服務即可讓 `/webhooks/line` 驗證簽章。

## 使用入口

在 LINE 內開啟：

`https://liff.line.me/2011336492-ay7OJ4mO`

Mac 必須保持開機，且本機公開服務與 Daniel Tunnel 必須持續運作；資料不在 LUECAT D1，本階段仍保留於本機 SQLite。
