export default function ApplicantHome() {
  return (
    <section className="applicant-home" aria-labelledby="app-title">
      <p className="eyebrow">竹流 FlowPass</p>
      <h1 id="app-title">用清楚的資料流向，申請 AI 工具補助</h1>
      <p className="applicant-home-lead">
        給已購買核准 AI 工具、並準備提出補助申請的新竹市青年。FlowPass 協助你在 LINE 完成申請與查詢進度；資格審核與撥款由市府辦理。
      </p>

      <div className="applicant-intro">
        <h2>這是什麼</h2>
        <p>
          FlowPass 會依你的說明整理一份「AI 資料護照」：資料從哪裡來、交給哪個工具、存在哪裡、誰會看到。審核人員據此了解你的使用方式。AI 只協助整理流向，不決定能不能補助、也不決定金額。
        </p>
        <p>
          預估需 10–15 分鐘。請先準備身分證正反面、官方收據、刷卡單筆明細、存摺封面與切結書。申請、進度查詢與工具檢測請由 LINE 選單進入。
        </p>
      </div>

      <ol className="applicant-journey-steps" aria-label="申請步驟">
        <li>
          <strong>步驟 1：填寫概況</strong>
          <span>依序回答 6 題：資料類型、用途、敏感資料、存放與分享對象、使用工具、保存期限。請寫實際流程，不必貼上檔案內容。</span>
        </li>
        <li>
          <strong>步驟 2：確認流向</strong>
          <span>檢視並確認 AI 產生的資料流向草稿；若有不清楚處，系統會再問你幾題。</span>
        </li>
        <li>
          <strong>步驟 3：上傳附件並送出</strong>
          <span>填寫購買資料並上傳必備文件。送出後可在「進度查詢」追蹤審核與補件。</span>
        </li>
      </ol>

      <aside className="applicant-prep-note" aria-labelledby="prep-title">
        <h2 id="prep-title">必備文件</h2>
        <ul>
          <li>身分證正反面：核對申請人身分與設籍</li>
          <li>官方收據與刷卡單筆明細：核對軟體、金額與日期</li>
          <li>存摺封面：核對匯款帳戶</li>
          <li>切結書：申請時需上傳；代付另需代付切結書，低收／中低收入戶另需資格證明</li>
        </ul>
        <p>審核與防重複請領所需之個人資料皆會加密保存；信用卡資訊僅透過加密比對，系統不留存明文。</p>
      </aside>

      <aside className="applicant-intro applicant-intro--limits" aria-labelledby="limits-title">
        <h2 id="limits-title">LINE 可以幫你什麼</h2>
        <p>
          可用關鍵字詢問怎麼申請、護照是什麼、補助多少，或查案件進度。資格細節以市府公告為準；入帳確切日期屬市府流程，此處無法確認。答不出來時，可改問關鍵字、查看公告，或於上班時間洽詢市府窗口。
        </p>
      </aside>

      <p className="pending-note" role="status">申請、進度查詢與檢測請由 LINE 選單進入。未完成的草稿亦可由此接續填寫。</p>
    </section>
  );
}
