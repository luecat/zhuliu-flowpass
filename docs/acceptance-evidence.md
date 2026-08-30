# FlowPass 驗收證據

本機驗收以 deterministic fixtures、SQLite transaction 與 loopback Hono 服務為主。每次 release 需保存：測試摘要、typecheck/lint/build 輸出、release manifest 雜湊、backup/restore-check 結果與 `ops:doctor -- --offline` 報告。

外部 LINE、Cloudflare Tunnel、DNS、macOS Keychain 與正式 HTTPS 連線是 deployment gate；沒有明確授權時不執行，也不把未執行項目標成通過。
