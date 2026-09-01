import Link from 'next/link';

export default function ApplicantHome() {
  return <section className="applicant-home" aria-labelledby="app-title">
    <p className="eyebrow">竹流 FlowPass</p>
    <h1 id="app-title">把申請資料整理成清楚的使用流向</h1>
    <p>先回答四個問題，確認後再整理申請內容。</p>
    <nav aria-label="申請功能" className="applicant-actions">
      <Link className="primary-action" href="/app/apply">送出申請</Link>
      <Link className="secondary-action" href="/app/passports">查詢申請進度</Link>
    </nav>
    <p className="pending-note" role="status">申請與查詢紀錄都會綁定你的 LINE 登入。</p>
  </section>;
}
