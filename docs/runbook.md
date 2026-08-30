# FlowPass 本機操作手冊

FlowPass 的公開頁面、管理後台、工作程序只綁定本機回環位址。正式網域、LINE、Cloudflare Tunnel 與 Keychain 值不會由建置流程自動變更。

## 初次安裝

1. `npm install`
2. `npm run build`
3. `npm run build:bundles`
4. `npm run package:release`
5. `npm run configure-local`（只寫非秘密設定）
6. 以互動式 `npm run secrets -- bind <logical-name>` 綁定 Keychain 參照，再以 `npm run keychain:doctor` 檢查狀態。

## 啟停與更新

- 公開服務：`npm run start:public`
- 管理服務：`npm run start:admin`
- 工作程序：`FLOWPASS_WORKER_RUN=1 npm run start:worker`
- 更新時建立新的 release；`current` 只以原子 symlink 切換，不覆蓋 data、vault 或 backups。
- 回退：`npx tsx scripts/release-rollback.ts <release-id>`；不刪除任何舊 release。

## 最快試跑

在 `site/` 目錄執行 `npm run dev:public`，瀏覽 `http://127.0.0.1:38100/apply`。需要測試背景工作時，另開終端執行 `FLOWPASS_WORKER_RUN=1 npm run dev:worker`；管理後台則執行 `npm run dev:admin`，再開啟 `http://127.0.0.1:38101/`。第一次使用管理後台前，先以 `npm run admin:bootstrap` 建立本機管理員帳號。

## 備份與復原

`npm run backup` 使用 SQLite Online Backup API 並寫入含雜湊的 manifest；`npm run restore:check` 會以唯讀方式驗證完整性。備份失敗時不執行 retention 刪除。SQLite busy/corruption、Keychain locked、MODEL_OFFLINE、OCR failure、LINE 401/429、tunnel 1016 與 invalid release manifest 都應先停止對應服務、保留現場，再依 `ops:doctor -- --offline` 結果逐項修復。

## 日誌與敏感資料

只保留系統服務的標準輸出與錯誤輸出；不要在 shell 參數、日誌或 issue 中貼上 token、Keychain 值、發票號碼、LINE subject 或原始文件。Loopback 是網路邊界，不代表同一 macOS 使用者遭入侵時仍安全。
