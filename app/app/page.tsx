export default function ApplicantHome() {
  return (
    <section className="applicant-home" aria-labelledby="app-title">
      <p className="eyebrow">竹流 FlowPass</p>
      <h1 id="app-title">建立清晰的 AI 資料流向</h1>
      <p>約 10–15 分鐘可完成。開始前請先準備身分證、購買憑證（發票）與存摺封面。</p>

      <ol className="applicant-journey-steps" aria-label="申請步驟">
        <li>
          <strong>步驟 1：填寫概況</strong>
          <span>描述資料類型、用途、敏感資料與分享對象</span>
        </li>
        <li>
          <strong>步驟 2：確認流向</strong>
          <span>檢視並確認 AI 產生的資料流向草稿</span>
        </li>
        <li>
          <strong>步驟 3：上傳附件並送出</strong>
          <span>填寫購買資料並上傳必備文件</span>
        </li>
      </ol>

      <aside className="applicant-prep-note" aria-labelledby="prep-title">
        <h2 id="prep-title">必備文件</h2>
        <ul>
          <li>身分證正反面：核對申請人身分</li>
          <li>購買憑證或發票：核對軟體、金額與日期</li>
          <li>存摺封面：核對匯款帳戶</li>
        </ul>
        <p>審核與防重複請領所需之個人資料皆會加密保存；信用卡資訊僅透過加密比對，系統不留存明文。</p>
      </aside>

      <p className="pending-note" role="status">請從 LINE 選單開啟申請、進度查詢或護照檢測；未完成的草稿可從選單的申請入口接續填寫。</p>
    </section>
  );
}
