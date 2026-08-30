# FlowPass 驗收證據

本機驗收以 deterministic fixtures、SQLite transaction 與 loopback Hono 服務為主。每次 release 需保存：測試摘要、typecheck/lint/build 輸出、release manifest 雜湊、backup/restore-check 結果與 `ops:doctor -- --offline` 報告。

外部 LINE、Cloudflare Tunnel、DNS、macOS Keychain 與正式 HTTPS 連線是 deployment gate；沒有明確授權時不執行，也不把未執行項目標成通過。

## 公開 LIFF 設定

正式 Sites 環境已配置 LINE Login Channel ID `2011336492` 與 LIFF ID
`2011336492-ay7OJ4mO`。這兩個值均為公開識別碼；Channel Secret、Messaging
API token 與其他密鑰仍只允許由本機 Keychain 提供。
